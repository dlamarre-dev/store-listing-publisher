// Node environment: nothing here touches the DOM. The extension's lib/ files are
// plain scripts with a module.exports tail, so Jest requires them directly.
module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/**/*.test.js'],
  collectCoverageFrom: ['extension/lib/**/*.js'],
};
