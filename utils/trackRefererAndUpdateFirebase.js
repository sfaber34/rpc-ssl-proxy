// Global map: key = referer URL, value = count
const countMap = {};

// Increment the count for a single referer URL
function trackReferersByCount(referer) {
    if (!referer) return;
    // Clean the referer: remove protocol and trailing slash
    let cleaned = referer.replace(/^https?:\/\//, '').replace(/\/$/, '');
    countMap[cleaned] = (countMap[cleaned] || 0) + 1;
    console.log("countMap", countMap);
}

module.exports = { trackReferersByCount, countMap };
