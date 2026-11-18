// The exported page has no external API: nothing outside the page can drive it.
class GraphApiError extends Error {}

class GraphFrontierApi {
  close() {}
}

const MAX_PAGE = 0;
export { GraphFrontierApi, GraphApiError, MAX_PAGE };
