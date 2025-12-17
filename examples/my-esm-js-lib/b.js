/**
 * Exported class.
 */
export class MyClass {
  /**
   * Greet someone.
   */
  greet(name) {
    return `hi ${name}`;
  }
}

/** Exported constant (to show `export *` surfaces non-function exports too). */
export const meaningOfLife = 42;

/**
 * Internal class (not exported).
 */
class Internal {
  doIt() {
    return 123;
  }
}

void Internal;


