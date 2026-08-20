// Config loading, merging and validation.
//
// Two layers, on purpose. The project whose assets are being published owns the
// interesting half — items, path templates, the locale table — and can commit
// it to its own repo, where its own tests can check it (that the locale list
// still matches the extension's _locales, say). This tool's config.json then
// holds only what must not be committed anywhere: the publisher UUID and the
// AMO API secret. It points at the other with:
//
//   { "extends": "E:/my-project/store-publisher.config.json", ... }
//
// The local file wins on every key it declares. Objects merge a level at a
// time, so a local `amo: { jwt_secret }` does not erase the project's
// `amo: { previewSet }`; arrays replace wholesale, since a half-overridden
// locale table would be worse than either version.

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function mergeConfig(base, over) {
  const out = { ...base };
  for (const [key, value] of Object.entries(over || {})) {
    if (value === undefined) continue;
    out[key] = isPlainObject(value) && isPlainObject(base[key])
      ? mergeConfig(base[key], value)
      : value;
  }
  return out;
}

// A path is absolute if it starts with "/" or with a drive letter. Relative
// `extends` values resolve against the directory of the file that declared
// them, which is the only anchor that survives the repo being moved.
function isAbsolutePath(p) {
  return /^([A-Za-z]:[\\/]|[\\/])/.test(String(p));
}

function dirName(p) {
  const idx = Math.max(String(p).lastIndexOf('/'), String(p).lastIndexOf('\\'));
  return idx === -1 ? '.' : String(p).slice(0, idx);
}

function resolveExtendsPath(extendsValue, fromPath) {
  if (isAbsolutePath(extendsValue)) return String(extendsValue);
  const sep = String(fromPath).includes('\\') ? '\\' : '/';
  return dirName(fromPath) + sep + String(extendsValue).replace(/^[.][\\/]/, '');
}

const STORE_PROFILES = ['chrome', 'firefox'];

function validateConfig(config) {
  const problems = [];

  if (!Array.isArray(config.items) || !config.items.length) {
    problems.push('items: must be a non-empty array');
  } else {
    config.items.forEach((item, i) => {
      for (const field of ['slug', 'name']) {
        if (!item[field]) problems.push(`items[${i}].${field}: required`);
      }
    });
  }

  const assets = config.assets;
  if (!isPlainObject(assets)) {
    problems.push('assets: required object');
  } else {
    // The tool used to derive this from where it sat on disk. It no longer
    // lives inside the project it publishes, so there is nothing to derive.
    if (!assets.root) {
      problems.push('assets.root: required — the absolute path the templates hang off');
    } else if (!isAbsolutePath(assets.root)) {
      problems.push(`assets.root: must be absolute, got "${assets.root}"`);
    }
    const declared = STORE_PROFILES.filter(p => isPlainObject(assets[p]));
    if (!declared.length) {
      problems.push(`assets: declare at least one of ${STORE_PROFILES.join(', ')}`);
    }
    for (const profile of declared) {
      if (!assets[profile].description && !assets[profile].screenshot) {
        problems.push(`assets.${profile}: needs a description and/or screenshot template`);
      }
      const perListing = assets[profile].screenshotsPerListing;
      if (perListing !== undefined && !(Number.isInteger(perListing) && perListing > 0)) {
        problems.push(`assets.${profile}.screenshotsPerListing: must be a positive integer`);
      }
    }
  }

  if (problems.length) {
    throw new Error('Invalid configuration:\n  - ' + problems.join('\n  - '));
  }
  return config;
}

function screenshotsPerListing(profile) {
  return profile.screenshotsPerListing || 5;
}

if (typeof module !== 'undefined') {
  module.exports = {
    mergeConfig, validateConfig, resolveExtendsPath, isAbsolutePath,
    dirName, screenshotsPerListing, STORE_PROFILES,
  };
}
