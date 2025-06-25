import https from "https";
import express from "express";
import axios from "axios";
import fs from "fs";
import cors from "cors";
import bodyParser from "body-parser";
import { fileURLToPath } from 'url';
import ethers from "ethers";
import sslRootCas from "ssl-root-cas";
import dotenv from "dotenv";
import { updateUrlCountMap, startBackgroundTasks } from './utils/backgroundTasks.js';

var app = express();
https.globalAgent.options.ca = sslRootCas.create();
dotenv.config();
process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = 0;

const targetUrl = process.env.TARGET_URL;

app.use(bodyParser.json());
app.use(cors());

var last = "";

var memcache = {};
var methods = {};
var methodsByReferer = {};

app.post("/", (req, res) => {
  if (req.headers && req.headers.referer) {
    updateUrlCountMap(req.headers.referer);
    if (last === req.connection.remoteAddress) {
      //process.stdout.write(".");
      //process.stdout.write("-")
    } else {
      last = req.connection.remoteAddress;
      if (!memcache[req.headers.referer]) {
        memcache[req.headers.referer] = 1;
        process.stdout.write(
          "NEW SITE " +
            req.headers.referer +
            " --> " +
            req.connection.remoteAddress
        );
        process.stdout.write("🪐 " + req.connection.remoteAddress);
      } else {
        memcache[req.headers.referer]++;
      }
    }
  }

  if (req.body && req.body.method) {
    methods[req.body.method] = methods[req.body.method]
      ? methods[req.body.method] + 1
      : 1;
    console.log("--> METHOD", req.body.method, "REFERER", req.headers.referer);

    if (!methodsByReferer[req.headers.referer]) {
      methodsByReferer[req.headers.referer] = {};
    }

    methodsByReferer[req.headers.referer] &&
    methodsByReferer[req.headers.referer][req.body.method]
      ? methodsByReferer[req.headers.referer][req.body.method]++
      : (methodsByReferer[req.headers.referer][req.body.method] = 1);
  }
  axios
    .post(targetUrl, req.body, {
      headers: {
        "Content-Type": "application/json",
        ...req.headers,
      },
    })
    .then((response) => {
      console.log("POST RESPONSE", response.data);
      res.status(response.status).send(response.data);
    })
    .catch((error) => {
      console.log("POST ERROR", error);
      res
        .status(error.response ? error.response.status : 500)
        .send(error.message);
    });

  console.log("POST SERVED", req.body);
});

app.get("/", (req, res) => {
  try {
    console.log("GET", req.headers.referer || "no referer");
    axios
      .get(targetUrl, {
        headers: {
          ...req.headers,
        },
      })
      .then((response) => {
        console.log("GET RESPONSE", response.data);
        res.status(response.status).send(response.data);
      })
      .catch((error) => {
        console.log("GET ERROR", error.message);
        res
          .status(error.response ? error.response.status : 500)
          .send(error.message);
      });

    console.log("GET REQUEST SERVED");
  } catch (err) {
    console.error("GET / error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/proxy", (req, res) => {
  try {
    console.log("/PROXY", req.headers.referer);
    res.send(
      "<html><body><div style='padding:20px;font-size:18px'><H1>PROXY TO:</H1></div><pre>" +
        targetUrl +
        "</pre></body></html>"
    );
  } catch (err) {
    console.error("/proxy error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/methods", (req, res) => {
  try {
    console.log("/methods", req.headers.referer);
    res.send(
      "<html><body><div style='padding:20px;font-size:18px'><H1>methods:</H1></div><pre>" +
        JSON.stringify(methods) +
        "</pre></body></html>"
    );
  } catch (err) {
    console.error("/methods error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/methodsByReferer", (req, res) => {
  try {
    console.log("/methods", req.headers.referer);
    res.send(
      "<html><body><div style='padding:20px;font-size:18px'><H1>methods by referer:</H1></div><pre>" +
        JSON.stringify(methodsByReferer) +
        "</pre></body></html>"
    );
  } catch (err) {
    console.error("/methodsByReferer error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/letathousandscaffoldethsbloom", (req, res) => {
  try {
    //if(req.headers&&req.headers.referer&&req.headers.referer.indexOf("sandbox.eth.build")>=0){
    var sortable = [];
    for (var item in memcache) {
      sortable.push([item, memcache[item]]);
    }
    sortable.sort(function (a, b) {
      return b[1] - a[1];
    });
    let finalBody = "";
    for (let s in sortable) {
      console.log(sortable[s]);
      finalBody +=
        "<div style='padding:10px;font-size:18px'> <a href='" +
        sortable[s][0] +
        "'>" +
        sortable[s][0] +
        "</a>(" +
        sortable[s][1] +
        ")</div>";
    }
    //JSON.stringify(sortable)
    res.send(
      "<html><body><div style='padding:20px;font-size:18px'><H1>RPC TRAFFIC</H1></div><pre>" +
        finalBody +
        "</pre></body></html>"
    );
  } catch (err) {
    console.error("/letathousandscaffoldethsbloom error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/watchdog", (req, res) => {
  try {
    res.json({ ok: true });
  } catch (err) {
    console.error("/watchdog error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Start background tasks
startBackgroundTasks();

let key, cert;
try {
  key = fs.readFileSync("server.key");
  cert = fs.readFileSync("server.cert");
} catch (err) {
  console.error("Failed to read SSL certificate files:", err);
  process.exit(1);
}

https
  .createServer(
    {
      key,
      cert,
    },
    app
  )
  .listen(443, () => {
    console.log("Listening 443...");
  });
