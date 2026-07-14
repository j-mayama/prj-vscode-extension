module.exports = {
  proxy: {
    target: "https://nginx",
    proxyOptions: {
      secure: false,
    },
    reqHeaders: {
      host: "localhost:8080",
      "x-forwarded-proto": "https",
    },
  },
  host: "0.0.0.0",
  https: false,
  port: 3000,
  ui: {
    port: 3001,
  },
  open: false,
  notify: false,
  files: [
    "assets/css/**/*.css",
    "assets/js/**/*.js",
    "*.php",
    "includes/**/*.php",
    "**/*.html",
    "**/*.htm",
    "wp-content/themes/**/*.php",
    "wp-content/themes/**/*.js",
    "wp-content/themes/**/*.css",
  ],
  watchOptions: {
    ignoreInitial: true,
    usePolling: true,
    interval: 300,
    awaitWriteFinish: {
      stabilityThreshold: 150,
      pollInterval: 50,
    },
  },
};
