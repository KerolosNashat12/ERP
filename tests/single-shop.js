/**
 * Imported first by every test that is about the single-shop build.
 *
 * `platform.json` ships with the fleet switched on, because that is what the
 * hosted deployment needs and a file in the repository is one less thing for
 * its owner to get wrong. These tests must not inherit it. It has to happen in
 * a module of its own rather than a line at the top of each file: static
 * imports are evaluated before any statement in the importing module runs, so
 * `process.env.MM_PLATFORM = '0'` written above `import ... from server.js`
 * would be set *after* the config it is trying to influence had already been
 * read and frozen.
 */
process.env.MM_PLATFORM = '0';
