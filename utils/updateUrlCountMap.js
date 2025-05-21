// Increment the count for a single referer URL
function updateUrlCountMap(referer, urlCountMap) {
  try {
    if (!referer) return;
    // Clean the referer: remove protocol and trailing slash
    let cleaned = referer.replace(/^https?:\/\//, '').replace(/\/$/, '');
    urlCountMap[cleaned] = (urlCountMap[cleaned] || 0) + 1;
    console.log("urlCountMap", urlCountMap);
  } catch (error) {
    console.error('Error updating urlCountMap:', error);
  }
}

export { updateUrlCountMap };