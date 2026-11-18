// The exported page has no external API: nothing outside the page can drive it.
class GraphApiError extends Error {}

class GraphFrontierApi {
  close() {}
}

module.exports = { GraphFrontierApi, GraphApiError, MAX_PAGE: 0 };
