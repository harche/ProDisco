export { foo, internalFn as publicFn } from './a.js';

import { importedFn as localImported } from './a.js';
export { localImported as importedFnPublic };

export * from './b.js';


