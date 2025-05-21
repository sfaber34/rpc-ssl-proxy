// Global map: key = referer URL, value = count
const urlCountMap = {};

// Increment the count for a single referer URL
function updateUrlCountMap(referer) {
    if (!referer) return;
    // Clean the referer: remove protocol and trailing slash
    let cleaned = referer.replace(/^https?:\/\//, '').replace(/\/$/, '');
    urlCountMap[cleaned] = (urlCountMap[cleaned] || 0) + 1;
    console.log("urlCountMap", urlCountMap);
}

export { updateUrlCountMap, urlCountMap };