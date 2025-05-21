const https = require("https");
const express = require("express");
const axios = require("axios");
const fs = require("fs");
var cors = require("cors");
var bodyParser = require("body-parser");
var app = express();
const ethers = require("ethers");
https.globalAgent.options.ca = require("ssl-root-cas").create();
process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = 0;

require('dotenv').config();
const targetUrl = process.env.TARGET_URL;

// Import the referer tracking function and map
const { trackReferersByCount } = require("./utils/trackRefererAndUpdateFirebase");

app.use(bodyParser.json());
app.use(cors());

var last = "";

var memcache = {};
var methods = {};
var methodsByReferer = {};

app.post("/", (req, res) => {
  if (req.headers && req.headers.referer) {
    trackReferersByCount(req.headers.referer);
    if (last === req.connection.remoteAddress) {
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
      // Strip any leading non-JSON characters from the response before sending
      let dataToSend = response.data;
      if (Buffer.isBuffer(dataToSend)) {
        dataToSend = dataToSend.toString('utf8');
      }
      if (typeof dataToSend === 'string') {
        const firstBrace = dataToSend.indexOf('{');
        if (firstBrace !== -1) {
          dataToSend = dataToSend.slice(firstBrace);
        }
        try {
          dataToSend = JSON.parse(dataToSend);
        } catch (e) {
          console.error('Could not parse cleaned response as JSON:', dataToSend);
          return res.status(500).json({ error: 'Upstream response was not valid JSON.' });
        }
      }
      console.log("POST RESPONSE", dataToSend);
      res.status(response.status).json(dataToSend);
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
});

app.get("/proxy", (req, res) => {
  console.log("/PROXY", req.headers.referer);
  res.send(
    "<html><body><div style='padding:20px;font-size:18px'><H1>PROXY TO:</H1></div><pre>" +
      targetUrl +
      "</pre></body></html>"
  );
});

app.get("/methods", (req, res) => {
  console.log("/methods", req.headers.referer);
  res.send(
    "<html><body><div style='padding:20px;font-size:18px'><H1>methods:</H1></div><pre>" +
      JSON.stringify(methods) +
      "</pre></body></html>"
  );
});

app.get("/methodsByReferer", (req, res) => {
  console.log("/methods", req.headers.referer);
  res.send(
    "<html><body><div style='padding:20px;font-size:18px'><H1>methods by referer:</H1></div><pre>" +
      JSON.stringify(methodsByReferer) +
      "</pre></body></html>"
  );
});

app.get("/letathousandscaffoldethsbloom", (req, res) => {
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
});

https
  .createServer(
    {
      key: fs.readFileSync("server.key"),
      cert: fs.readFileSync("server.cert"),
    },
    app
  )
  .listen(443, () => {
    console.log("Listening 443...");
  });
