class GraphApiError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
function fail(code, message) {
  throw new GraphApiError(code, message);
}
module.exports = { GraphApiError, fail };
