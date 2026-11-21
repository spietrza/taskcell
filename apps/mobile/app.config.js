// Version comes from package.json; everything else lives in app.json.
const { version } = require("./package.json");

module.exports = ({ config }) => ({ ...config, version });
