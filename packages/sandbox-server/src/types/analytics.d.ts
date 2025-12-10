// Type declarations for analytics libraries without built-in TypeScript types

declare module 'ml-regression' {
  export class SimpleLinearRegression {
    constructor(x: number[], y: number[]);
    slope: number;
    intercept: number;
    predict(x: number): number;
    score(x: number[], y: number[]): number;
    toString(): string;
    toJSON(): object;
    static load(json: object): SimpleLinearRegression;
  }

  export class PolynomialRegression {
    constructor(x: number[], y: number[], degree: number);
    coefficients: number[];
    predict(x: number): number;
    score(x: number[], y: number[]): number;
    toString(): string;
    toJSON(): object;
    static load(json: object): PolynomialRegression;
  }

  export class ExponentialRegression {
    constructor(x: number[], y: number[]);
    coefficients: number[];
    predict(x: number): number;
    score(x: number[], y: number[]): number;
    toString(): string;
    toJSON(): object;
    static load(json: object): ExponentialRegression;
  }

  export class PowerRegression {
    constructor(x: number[], y: number[]);
    coefficients: number[];
    predict(x: number): number;
    score(x: number[], y: number[]): number;
    toString(): string;
    toJSON(): object;
    static load(json: object): PowerRegression;
  }

  export class MultivariateLinearRegression {
    constructor(x: number[][], y: number[] | number[][], options?: { intercept?: boolean });
    coefficients: number[][];
    predict(x: number[]): number[];
    score(x: number[][], y: number[] | number[][]): number;
    toJSON(): object;
    static load(json: object): MultivariateLinearRegression;
  }

  export class TheilSenRegression {
    constructor(x: number[], y: number[]);
    slope: number;
    intercept: number;
    predict(x: number): number;
    score(x: number[], y: number[]): number;
    toString(): string;
    toJSON(): object;
    static load(json: object): TheilSenRegression;
  }

  export class RobustPolynomialRegression {
    constructor(x: number[], y: number[], degree: number);
    coefficients: number[];
    predict(x: number): number;
    score(x: number[], y: number[]): number;
    toString(): string;
    toJSON(): object;
    static load(json: object): RobustPolynomialRegression;
  }
}

declare module 'fft-js' {
  type Phasor = [number[], number[]];

  export function fft(signal: number[]): Phasor;
  export function ifft(phasors: Phasor): number[];

  export const util: {
    fftMag(phasors: Phasor): number[];
    fftFreq(phasors: Phasor, sampleRate: number): number[];
  };
}
