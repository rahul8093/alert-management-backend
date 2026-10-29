class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Wraps an async route so thrown errors reach the error handler. */
const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const intParam = (v, d, min = 1, max = 1000) => {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return d;
  return Math.min(Math.max(n, min), max);
};

module.exports = { HttpError, asyncH, intParam };
