/**
 * Exported foo.
 */
export function foo() {
  return 1;
}

/**
 * Internal name, exported as `publicFn` from the package entry.
 */
export function internalFn() {
  return 2;
}

/**
 * Exported here, then re-exported via import+export from the package entry as `importedFnPublic`.
 */
export function importedFn() {
  return 3;
}

/**
 * Not exported (used to demonstrate that non-exported symbols are not indexed).
 */
function nonExportedFn() {
  return 4;
}

// Keep it referenced so bundlers/linters don't drop it in derived builds.
void nonExportedFn;


