import BigNumber from 'bignumber.js';
import {
  BatchPairsInfo,   
  GasMultiplier,
  Route,
  TokensConfig,
  convertCoinToUDenom,
  convertCoinFromUDenom,
} from '@shadeprotocol/shadejs';

export class NewtonMethodError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NewtonMethodError';
  }
}

interface ReverseTradeResult {
  newPool0: BigNumber,
  newPool1: BigNumber,
  tradeInput: BigNumber,
  tradeReturn: BigNumber,
  lpFeeAmount: BigNumber,
  shadeDaoFeeAmount: BigNumber,
}

interface TradeResult {
  newPool0: BigNumber,
  newPool1: BigNumber,
  tradeReturn: BigNumber,
  lpFeeAmount: BigNumber,
  shadeDaoFeeAmount: BigNumber,
}

// Throughout the comments we compare this curve with constant product curve -
// keep in mind that this is only for clarity, nothing here is actually a constant product curve

// Calculates a zero of f and its derivative df using newton's method.
// Accuracy is guaranteed to be <= epsilon.
// Errors out if maxIterations is exceeded.
export function newton({
  f,
  df,
  initialGuess,
  epsilon,
  maxIterations,
}:{
  f: (a: BigNumber) => BigNumber,
  df: (a: BigNumber) => BigNumber,
  initialGuess: BigNumber,
  epsilon: BigNumber,
  maxIterations: number,
}): BigNumber {
  let xn: BigNumber = initialGuess;
  for (let i = 0; i < maxIterations; i += 1) {
    const xPrev: BigNumber = xn;

    const fxn: BigNumber = f(xn);
    const dfxn: BigNumber = df(xn);

    if (dfxn.isEqualTo(0)) {
      throw new NewtonMethodError('Newton encountered slope of 0');
    }

    xn = xn.minus(fxn.dividedBy(dfxn));
    if (xn.minus(xPrev).abs().isLessThanOrEqualTo(epsilon)) {
      return xn;
    }
  }

  throw new NewtonMethodError('Newton exceeded max iterations');
}

// Calculates a zero using bisection within bounds a and b. Similar o binary search.
// Accuracy is guaranteed to be <= epsilon.
// Errors out if maxIterations is exceeded.
// Precondition: f(a) and f(b) must have different signs,
// with a single zero of the equation between a and b.
// https://en.wikipedia.org/wiki/BisectionMethod
export function bisect({
  f,
  a,
  b,
  epsilon,
  maxIterations,
}: {
  f: (input: BigNumber) => BigNumber,
  a: BigNumber,
  b: BigNumber,
  epsilon: BigNumber,
  maxIterations: number,
}): BigNumber {
  const fa = f(a);
  const fb = f(b);

  if (fa.isEqualTo(0)) {
    return a;
  }
  if (fb.isEqualTo(0)) {
    return b;
  }

  if ((fa.isGreaterThan(0) && fb.isGreaterThan(0)) || (fa.isLessThan(0) && fb.isLessThan(0))) {
    throw Error('bisect endpoints must have different signs');
  }
  let step: BigNumber = b.minus(a);
  let newLowerBound: BigNumber = a;
  for (let i = 0; i < maxIterations; i += 1) {
    step = step.multipliedBy(BigNumber(0.5));

    const mid = newLowerBound.plus(step);
    const fm = f(mid);

    if (fa.multipliedBy(fm).isGreaterThanOrEqualTo(0)) {
      newLowerBound = mid;
    }
    if (fm || step.abs().isLessThanOrEqualTo(epsilon)) {
      return mid;
    }
  }
  throw Error('Bisect exceeded max iterations');
}

// Finds a zero of f using Newtons method, or bisect method if that fails.
// Allows for the lower bound of bisect to be lazy evaluated, since the lower bound
// for invariant as a fn of d is GM2, which is expensive to calculate.
// Lazy evaluation works by passing a fn into the 'lazyLowerBoundBisect' param,
// and passing 'None' to 'lowerBoundBisect'.
// The given fn will be called only if it is needed.
// Precondition: Exactly ONE of 'lowerBoundBisect' and 'lazyLowerBoundBisect' must exist
export function calcZero({
  f,
  df,
  initialGuessNewton,
  upperBoundBisect,
  ignoreNegativeResult,
  lazyLowerBoundBisect,
  lowerBoundBisect,
}:{
  f: (a: BigNumber) => BigNumber,
  df: (a: BigNumber) => BigNumber,
  initialGuessNewton: BigNumber,
  upperBoundBisect: BigNumber,
  ignoreNegativeResult: boolean,
  lazyLowerBoundBisect?: () => BigNumber,
  lowerBoundBisect?: BigNumber,
}): BigNumber {
  const precision = BigNumber(0.0000000000000001); // 1e-16
  const maxIterNewton = 80;
  const maxIterBisect = 150;

  try {
    // attempt to find the zero with newton's method
    const newtonResult = newton({
      f,
      df,
      initialGuess: initialGuessNewton,
      epsilon: precision,
      maxIterations: maxIterNewton,
    });
    if (!ignoreNegativeResult || newtonResult.isGreaterThanOrEqualTo(0)) {
      return newtonResult;
    }
  } catch (error) {
    if (error instanceof NewtonMethodError) {
      // do nothing, if Newton failed this fn will fall back to bisect method
    } else {
      throw error;
    }
  }

  // if newton got a result and it's not negative when we are trying to avoid
  // negative results, return it (sometimes the invariant curve has both a negative
  // and a positive zero, and we want to avoid the negative one)

  // fall back to bisect method

  if (lowerBoundBisect !== undefined) {
    return bisect({
      f,
      a: lowerBoundBisect,
      b: upperBoundBisect,
      epsilon: precision,
      maxIterations: maxIterBisect,
    });
  } if (lazyLowerBoundBisect !== undefined) {
    // actually evaluate the lower bound since it is needed now
    return bisect({
      f,
      a: lazyLowerBoundBisect(),
      b: upperBoundBisect,
      epsilon: precision,
      maxIterations: maxIterBisect,
    });
  }
  throw Error(
    'No lower bound was found for bisect',
  );
}

// Generates an error if swapAmount is not a legal swap amount.
export function verifySwapAmountInBounds(swapAmount: BigNumber, minTradeSize: BigNumber) {
  if (swapAmount.isLessThanOrEqualTo(0)) {
    throw Error('Trade size must be positive');
  }
  if (swapAmount.isLessThanOrEqualTo(minTradeSize)) {
    throw Error(`Trade size must be larger than minimum trade size of ${minTradeSize}`);
  }
}

export class StableConfig {
  // pool size of first asset
  pool0Size: BigNumber;

  // pool size of second asset
  pool1Size: BigNumber;

  // price of asset 1 in terms of asset 0 (units: asset0 / asset1)
  // the value 'py' is common throughout the code. This is simply p*y,
  // or the total value locked (TVL) of asset y in terms of x
  priceOfToken1: BigNumber;

  // manually set param which controls the 'flatness' of the curve near equilibrium
  alpha: BigNumber;

  // manually set param which controls how the quickly the curve gains slippage when
  // X is underrepresented
  gamma1: BigNumber;

  // manually set param which controls how the quickly the curve gains slippage when
  // X is overrepresented
  gamma2: BigNumber;

  // the percentage fee to be taken from every trade for lp providers (eg 0.001 is a 0.1% fee)
  lpFee: BigNumber;

  // the percentage fee to be taken from every trade for shade dao (eg 0.001 is a 0.1% fee)
  shadeDaoFee: BigNumber;

  // the invariant of the pool, calculated by finding the zero of the invariant function
  // (analogous to x * y if this was a constant product curve)
  // referred to as 'd' occasionally
  invariant: BigNumber;

  minTradeSize0For1: BigNumber;

  minTradeSize1For0: BigNumber;

  priceImpactLimit: BigNumber;

  constructor({
    pool0Size,
    pool1Size,
    priceRatio,
    alpha,
    gamma1,
    gamma2,
    lpFee,
    shadeDaoFee,
    minTradeSize0For1,
    minTradeSize1For0,
    priceImpactLimit,
  }: {
    pool0Size: BigNumber,
    pool1Size: BigNumber,
    priceRatio: BigNumber,
    alpha: BigNumber,
    gamma1: BigNumber,
    gamma2: BigNumber,
    lpFee: BigNumber,
    shadeDaoFee: BigNumber,
    minTradeSize0For1: BigNumber,
    minTradeSize1For0: BigNumber,
    priceImpactLimit: BigNumber,
  }) {
    BigNumber.set({ DECIMAL_PLACES: 30 });
    this.pool0Size = pool0Size;
    this.pool1Size = pool1Size;
    this.priceOfToken1 = priceRatio;
    this.alpha = alpha;
    this.gamma1 = gamma1;
    this.gamma2 = gamma2;
    this.lpFee = lpFee;
    this.shadeDaoFee = shadeDaoFee;
    this.invariant = this.calculateInvariant();
    this.minTradeSize0For1 = minTradeSize0For1;
    this.minTradeSize1For0 = minTradeSize1For0;
    this.priceImpactLimit = priceImpactLimit;
  }

  // solves the invariant fn to find the balanced amount of y for the given x
  // e.g. for a given pool size x, what is the correct pool size y so that the
  // invariant is not changed?
  // analogous to 'output = (x * y) / (x + input)' for constant product trades
  solveInvFnForPool1Size(pool0Size: BigNumber): BigNumber {
    const xOverD: BigNumber = pool0Size.dividedBy(this.invariant);

    const f = (py: BigNumber): BigNumber => this.invariantFnFromPoolSizes(xOverD, py);
    const df = (py: BigNumber): BigNumber => this.derivRespectToPool1OfInvFn(xOverD, py);

    const root = this.findZeroWithPool1Params(f, df);
    return root.multipliedBy(this.invariant).dividedBy(this.priceOfToken1);
  }

  // solves the invariant fn to find the balanced amount of x for the given y
  // e.g. for a given pool size y, what is the correct pool size x so that the
  // invariant is not changed?
  // analogous to 'output = (x * y) / (y + input)' for constant product trades
  solveInvFnForPool0Size(pool1SizeInUnitsOfPool0: BigNumber): BigNumber {
    const pyOverD: BigNumber = pool1SizeInUnitsOfPool0.dividedBy(this.invariant);

    const f = (x: BigNumber): BigNumber => this.invariantFnFromPoolSizes(x, pyOverD);
    const df = (x: BigNumber): BigNumber => this.derivRespectToPool0OfInvFnFromPool0(x, pyOverD);

    const root = this.findZeroWithPool0Params(f, df);
    return root.multipliedBy(this.invariant);
  }

  // Executes a swap of x for y, if the trade is within amount and slippage bounds.
  swapToken0WithToken1(token0Input: BigNumber): BigNumber {
    const tradeRes: TradeResult = this.simulateToken0WithToken1Trade(token0Input);
    return this.executeTrade(tradeRes);
  }

  // Executes a swap of y for x, if the trade is within amount and slippage bounds.
  swapToken1WithToken0(token1Input: BigNumber): BigNumber {
    const tradeRes: TradeResult = this.simulateToken1WithToken0Trade(token1Input);
    return this.executeTrade(tradeRes);
  }

  // Applies the data from a TradeResult to the given conf.
  // takes a simulated trade and actually updates the config's values to reflect that the
  // trade went through
  private executeTrade(trade: TradeResult): BigNumber {
    this.pool0Size = trade.newPool0;
    this.pool1Size = trade.newPool1;
    this.calculateInvariant();
    return trade.tradeReturn;
  }

  // Simulates a swap of x for y, given the output y, if the trade is within amount and slippage bounds.
  // Returns data about the state of the conf after the swap.
  simulateReverseToken0WithToken1Trade(token1Output: BigNumber): ReverseTradeResult {
    const lpFeeAmount = this.lpFee.multipliedBy(token1Output);
    const shadeDaoFeeAmount = this.shadeDaoFee.multipliedBy(token1Output);

    const totalFeeAmount = lpFeeAmount.plus(shadeDaoFeeAmount);
    const token1OutputAfterFee = token1Output.minus(totalFeeAmount);

    // calculate the sizes of the pool after the trades go through
    const newToken1Pool: BigNumber = this.pool1Size.minus(token1Output);
    const newToken1PoolInUnitsToken0 = newToken1Pool.multipliedBy(this.priceOfToken1);
    const newToken0Pool: BigNumber = this.solveInvFnForPool0Size(newToken1PoolInUnitsToken0);

    // make sure the trade is within a reasonable price impact range
    this.verifySwapPriceImpactInBounds({
      pool0Size: newToken0Pool,
      pool1Size: newToken1Pool,
      tradeDirIs0For1: true,
    });

    const tradeInput = newToken0Pool.minus(this.pool0Size);
    verifySwapAmountInBounds(tradeInput, this.minTradeSize0For1);

    // add the fees to the pool
    const newToken1PoolFeeAdded = newToken1Pool.plus(lpFeeAmount);

    // return a TradeResult with the new pool sizes, fee amounts, and trade return
    return {
      newPool0: newToken0Pool,
      newPool1: newToken1PoolFeeAdded,
      tradeInput,
      tradeReturn: token1OutputAfterFee,
      lpFeeAmount,
      shadeDaoFeeAmount,
    };
  }

  // Simulates a swap of y for x, given the output x, if the trade is within amount and slippage bounds.
  // Returns data about the state of the conf after the swap.
  simulateReverseToken1WithToken0Trade(token0Output: BigNumber): ReverseTradeResult {
    const lpFeeAmount = this.lpFee.multipliedBy(token0Output);
    const shadeDaoFeeAmount = this.shadeDaoFee.multipliedBy(token0Output);

    const totalFeeAmount = lpFeeAmount.plus(shadeDaoFeeAmount);
    const token0OutputAfterFee = token0Output.minus(totalFeeAmount);

    // calculate the sizes of the pool after the trades go through
    const newToken0Pool: BigNumber = this.pool0Size.minus(token0Output);
    const newToken1Pool: BigNumber = this.solveInvFnForPool1Size(newToken0Pool);

    // make sure the trade is within a reasonable price impact range
    this.verifySwapPriceImpactInBounds({
      pool0Size: newToken0Pool,
      pool1Size: newToken1Pool,
      tradeDirIs0For1: false,
    });

    const tradeInput = newToken1Pool.minus(this.pool1Size);
    verifySwapAmountInBounds(tradeInput, this.minTradeSize1For0);

    // add the fees to the pool
    const newToken0PoolFeeAdded = newToken0Pool.plus(lpFeeAmount);

    // return a TradeResult with the new pool sizes, fee amounts, and trade return
    return {
      newPool0: newToken0PoolFeeAdded,
      newPool1: newToken1Pool,
      tradeInput,
      tradeReturn: token0OutputAfterFee,
      lpFeeAmount,
      shadeDaoFeeAmount,
    };
  }

  // Simulates a swap of x for y, if the trade is within amount and slippage bounds.
  // Returns data about the state of the conf after the swap.
  simulateToken0WithToken1Trade(token0Input: BigNumber): TradeResult {
    verifySwapAmountInBounds(token0Input, this.minTradeSize0For1);

    // calculate the sizes of the pool after the trades go through
    const newToken0Pool: BigNumber = this.pool0Size.plus(token0Input);
    const newToken1Pool: BigNumber = this.solveInvFnForPool1Size(newToken0Pool);

    // make sure the trade is within a reasonable price impact range
    this.verifySwapPriceImpactInBounds({
      pool0Size: newToken0Pool,
      pool1Size: newToken1Pool,
      tradeDirIs0For1: true,
    });

    // find the trade return amount by subtracting desired pool size from current pool size
    const tradeReturnBeforeFee = this.pool1Size.minus(newToken1Pool);

    // find fee sizes from trade return
    const lpFeeAmount = this.lpFee.multipliedBy(tradeReturnBeforeFee);
    const shadeDaoFeeAmount = this.shadeDaoFee.multipliedBy(tradeReturnBeforeFee);

    // add the fees to the pool
    const newToken1PoolFeeAdded = newToken1Pool.plus(lpFeeAmount);

    // return a TradeResult with the new pool sizes, fee amounts, and trade return
    return {
      newPool0: newToken0Pool,
      newPool1: newToken1PoolFeeAdded,
      tradeReturn: tradeReturnBeforeFee.minus(lpFeeAmount).minus(shadeDaoFeeAmount),
      lpFeeAmount,
      shadeDaoFeeAmount,
    };
  }

  // Simulates a swap of y for x, if the trade is within amount and slippage bounds.
  // Returns data about the state of the conf after the swap.
  simulateToken1WithToken0Trade(token1Input: BigNumber): TradeResult {
    verifySwapAmountInBounds(token1Input, this.minTradeSize1For0);

    // calculate the sizes of the pool after the trades go through
    const newToken1Pool: BigNumber = this.pool1Size.plus(token1Input);

    // find the value of the y tokens in terms of x
    const newToken1PoolInUnitsToken0: BigNumber = this.priceOfToken1.multipliedBy(newToken1Pool);

    // find the x pool size needed to maintain the invariant
    const newToken0Pool: BigNumber = this.solveInvFnForPool0Size(newToken1PoolInUnitsToken0);

    this.verifySwapPriceImpactInBounds({
      pool0Size: newToken0Pool,
      pool1Size: newToken1Pool,
      tradeDirIs0For1: false,
    });

    // find the trade return amount by subtracting desired pool size from current pool size
    const tradeReturnBeforeFee = this.pool0Size.minus(newToken0Pool);

    // find fee sizes from trade return
    const lpFeeAmount = this.lpFee.multipliedBy(tradeReturnBeforeFee);
    const shadeDaoFeeAmount = this.shadeDaoFee.multipliedBy(tradeReturnBeforeFee);

    // add the fees to the pool
    const newToken0PoolFeeAdded = newToken0Pool.plus(lpFeeAmount);

    // return a TradeResult with the new pool sizes, fee amounts, and trade return
    return {
      newPool0: newToken0PoolFeeAdded,
      newPool1: newToken1Pool,
      tradeReturn: tradeReturnBeforeFee.minus(lpFeeAmount).minus(shadeDaoFeeAmount),
      lpFeeAmount,
      shadeDaoFeeAmount,
    };
  }

  // Generates an error if the swap's price impact exceeds the limit. Params x and y are the
  // new pool sizes after the trade in question is hypothetically completed.
  // Price impact results should never be negative, since it is measured in terms of the
  // incoming token.
  // The price of that token in the pool will always increase, leading to a positive price impact.
  private verifySwapPriceImpactInBounds({
    pool0Size,
    pool1Size,
    tradeDirIs0For1,
  }:{
    pool0Size: BigNumber,
    pool1Size: BigNumber,
    tradeDirIs0For1: boolean,
  }) {
    const priceImpact = this.priceImpactAt({
      newPool0: pool0Size,
      newPool1: pool1Size,
      tradeDirIs0For1,
    });
    if (priceImpact.isGreaterThan(this.priceImpactLimit) || priceImpact.isLessThan(BigNumber(0))) {
      throw Error(`The price impact of this trade (${priceImpact.toString()}%) is outside of the acceptable range of 0% - ${this.priceImpactLimit}%.`);
    }
  }

  // Returns the price impact associated with new x and y values (pool sizes),
  // relative to the current values stored in conf.
  private priceImpactAt({
    newPool0,
    newPool1,
    tradeDirIs0For1,
  }: {
    newPool0: BigNumber,
    newPool1: BigNumber,
    tradeDirIs0For1: boolean,
  }): BigNumber {
    // price of the token, based on pool sizes in conf
    const currPrice: BigNumber = tradeDirIs0For1 ? this.priceToken1() : this.priceToken0();

    const finalPrice: BigNumber = tradeDirIs0For1
      ? this.priceToken1At(newPool0, newPool1)

      // price of the tokens based on function parameter input
      : this.priceToken0At(newPool0, newPool1);

    // calculate price impact between two prices
    return (finalPrice.dividedBy(currPrice).minus(BigNumber(1))).multipliedBy(100);
  }

  // Returns the price impact for a swap of x for y, given the trade input.
  // result is expresed as percent so no conversion is necessary, ex. 263.5 = 263.5%
  priceImpactToken0ForToken1(tradeX: BigNumber): BigNumber {
    const newPool0: BigNumber = this.pool0Size.plus(tradeX);
    const pool1: BigNumber = this.solveInvFnForPool1Size(newPool0);
    return this.priceImpactAt({
      newPool0,
      newPool1: pool1,
      tradeDirIs0For1: true,
    });
  }

  // Returns the price impact for a swap of y for x, given the trade input.
  // result is expresed as percent so no conversion is necessary, ex. 263.5 = 263.5%
  priceImpactToken1ForToken0(tradeY: BigNumber): BigNumber {
    const newPool1: BigNumber = this.pool1Size.plus(tradeY);
    const pool0: BigNumber = this.solveInvFnForPool0Size(this.priceOfToken1.multipliedBy(newPool1));
    return this.priceImpactAt({
      newPool0: pool0,
      newPool1,
      tradeDirIs0For1: false,
    });
  }

  // Helper method for price.
  // Returns -1 * slope of tangent to inv curve at (x, y)
  // The slope (tangent) of the curve is the price of the token
  private negativeTangent(
    pool0: &BigNumber,
    pool1: &BigNumber,
  ): BigNumber {
    return (this.derivRespectToPool0OfInvFnFromPool0(pool0, pool1).dividedBy(this.derivRespectToPool1OfInvFn(pool0, pool1))).dividedBy(this.priceOfToken1);
  }

  /// Returns the price of y in terms of x, for given pool sizes of x and y.
  private priceToken1At(
    pool0: BigNumber,
    pool1: BigNumber,
  ): BigNumber {
    return BigNumber(1).dividedBy(this.negativeTangent(pool0.dividedBy(this.invariant), (this.priceOfToken1.multipliedBy(pool1)).dividedBy(this.invariant)));
  }

  // Returns the currect price of y in terms of x.
  priceToken1(): BigNumber {
    return this.priceToken1At(this.pool0Size, this.pool1Size);
  }

  // Returns the price of x in terms of y, for given pool sizes of x and y.
  private priceToken0At(
    pool0: BigNumber,
    pool1: BigNumber,
  ): BigNumber {
    return this.negativeTangent(pool0.dividedBy(this.invariant), (this.priceOfToken1.multipliedBy(pool1)).dividedBy(this.invariant));
  }

  // Returns the current price of x in terms of y.
  priceToken0(): BigNumber {
    return this.priceToken0At(this.pool0Size, this.pool1Size);
  }

  // Stores a new value for p and recalculates the invariant
  updatePriceOfToken1(priceOfToken1: BigNumber) {
    this.priceOfToken1 = priceOfToken1;
    this.calculateInvariant();
  }

  // Returns the TVL of asset y in terms of x.
  // A pool with 5 tokens of SILK at $1.05 SILK would return 1.05 * 5 = 5.25
  // This is the total value of y tokens in the pool, measured in terms of token x
  token1TvlInUnitsToken0(): BigNumber {
    return this.priceOfToken1.multipliedBy(this.pool1Size);
  }

  // Returns the total TVL of the pool in terms of x.
  totalTvl(): BigNumber {
    return this.pool0Size.plus(this.token1TvlInUnitsToken0());
  }

  // Returns twice the geometric mean of the current values of x and y
  // Returns 0 if either x or py is < 1
  geometricMeanDoubled(): BigNumber {
    const py = this.token1TvlInUnitsToken0();

    // sqrt does not work with numbers less than one
    if (this.pool0Size.isLessThanOrEqualTo(BigNumber(1)) || py.isLessThanOrEqualTo(BigNumber(1))) {
      return BigNumber(0);
    }
    return (this.pool0Size.sqrt().multipliedBy(py.sqrt())).multipliedBy(BigNumber(2));
  }

  // Calculates and returns the correct value of the invariant d, given the current conf,
  // by finding the 0 of the invariant fn.`
  calculateInvariant(): BigNumber {
    const pY = this.token1TvlInUnitsToken0();
    const gamma = this.pool0Size.isLessThanOrEqualTo(pY)
      ? this.gamma1
      : this.gamma2;
    const f = (d: BigNumber): BigNumber => this.invariantFnFromInv(d, gamma);
    const df = (d: BigNumber): BigNumber => this.derivRespectToInvOfInvFn(d, gamma);

    const invariant = this.findZeroWithInvariantParams(f, df);
    this.invariant = invariant;
    return invariant;
  }

  // INVARIANT AND DERIV FUNCTIONS

  // Returns the invariant as a function of d and gamma
  invariantFnFromInv(
    invariant: &BigNumber,
    gamma: &BigNumber,
  ): BigNumber {
    const py: BigNumber = this.token1TvlInUnitsToken0();
    const coeff: BigNumber = this.getCoeffScaledByInv({
      invariant,
      gamma,
      pool1SizeInUnitsPool0: py,
    });
    const term1: BigNumber = coeff.multipliedBy(invariant.multipliedBy((this.pool0Size.plus(py.minus(invariant)))));
    const term2: BigNumber = this.pool0Size.multipliedBy(py);
    const term3: BigNumber = (invariant.multipliedBy(invariant)).dividedBy(4);

    return term1.plus(term2).minus(term3);
  }

  // Returns the derivative of the invariant fn as a function of d and gamma.
  derivRespectToInvOfInvFn(
    invariant: &BigNumber,
    gamma: &BigNumber,
  ): BigNumber {
    const py = this.token1TvlInUnitsToken0();
    const coeff: BigNumber = this.getCoeffScaledByInv({
      invariant,
      gamma,
      pool1SizeInUnitsPool0: py,
    });
    const mainTerm: BigNumber = (BigNumber(-2).multipliedBy(gamma).plus(1)).multipliedBy((this.pool0Size.minus(invariant).plus(py)))
      .minus(invariant);
    return coeff.multipliedBy(mainTerm).minus(invariant.dividedBy(2));
  }

  // returns the 'coefficient' used in the invariant functions, scaled by d
  // this is just a simplification of the math, with no real world meaning
  // see whitepaper for full explanation
  private getCoeffScaledByInv({
    invariant,
    gamma,
    pool1SizeInUnitsPool0,
  }:{
    invariant: &BigNumber,
    gamma: &BigNumber,
    pool1SizeInUnitsPool0: &BigNumber,
  }): BigNumber {
    //
    return this.alpha.multipliedBy(((BigNumber(4).multipliedBy((this.pool0Size.dividedBy(invariant)))).multipliedBy((pool1SizeInUnitsPool0.dividedBy(invariant)))).pow(gamma));
  }

  // returns the 'coefficient' used in the invariant functions
  // this is just a simplification of the math, with no real world meaning
  // see whitepaper for full explanation
  private getCoeff({
    pool0Size,
    pool1SizeInUnitsPool0,
    gamma,
  }:{
    pool0Size: &BigNumber,
    pool1SizeInUnitsPool0: &BigNumber,
    gamma: &BigNumber,
  }): BigNumber {
    const xpy: BigNumber = pool0Size.multipliedBy(pool1SizeInUnitsPool0);
    return this.alpha.multipliedBy((BigNumber(4).multipliedBy(xpy)).pow(gamma));
  }

  // Returns the invariant fn as a function of x and py
  invariantFnFromPoolSizes(
    pool0Size: &BigNumber,
    pool1SizeInUnitsPool0: &BigNumber,
  ): BigNumber {
    const gamma = pool0Size.isLessThanOrEqualTo(pool1SizeInUnitsPool0) ? this.gamma1 : this.gamma2;
    const xpy: BigNumber = pool0Size.multipliedBy(pool1SizeInUnitsPool0);

    const coeff: BigNumber = this.getCoeff({
      pool0Size,
      pool1SizeInUnitsPool0,
      gamma,
    });
    const term1: BigNumber = coeff.multipliedBy((pool0Size.plus(pool1SizeInUnitsPool0).minus(1)));

    return term1.plus(xpy).minus(0.25);
  }

  // Returns the derivative of the invariant fn with respect to x as a function of x and py.
  derivRespectToPool0OfInvFnFromPool0(pool0Size: BigNumber, pool1SizeInUnitsOfPool0: BigNumber): BigNumber {
    const gamma = pool0Size.isLessThanOrEqualTo(pool1SizeInUnitsOfPool0) ? this.gamma1 : this.gamma2;
    const coeff: BigNumber = this.getCoeff({
      pool0Size,
      pool1SizeInUnitsPool0: pool1SizeInUnitsOfPool0,
      gamma,
    });
    const term1: BigNumber = (gamma.multipliedBy((pool0Size.plus(pool1SizeInUnitsOfPool0).minus(1)))).dividedBy(pool0Size).plus(1);
    return coeff.multipliedBy(term1).plus(pool1SizeInUnitsOfPool0);
  }

  // Returns the derivative of the invariant fn with respect to y as a function of x and py.
  derivRespectToPool1OfInvFn(pool0Size: BigNumber, pool1SizeInUnitsOfPool0: BigNumber): BigNumber {
    const gamma = pool0Size.isLessThanOrEqualTo(pool1SizeInUnitsOfPool0) ? this.gamma1 : this.gamma2;
    const coeff: BigNumber = this.getCoeff({
      pool0Size,
      pool1SizeInUnitsPool0: pool1SizeInUnitsOfPool0,
      gamma,
    });
    const term1: BigNumber = gamma.multipliedBy((pool0Size.plus(pool1SizeInUnitsOfPool0).minus(1)).dividedBy(pool1SizeInUnitsOfPool0)).plus(1);
    return coeff.multipliedBy(term1).plus(pool0Size);
  }

  // ZERO FINDER

  // Finds and returns a zero for the given fn f (with its derivative df).
  // Uses guesses and bounds optimized for calculating the invariant as a fn of d
  private findZeroWithInvariantParams(
    f: (a: BigNumber) => BigNumber,
    df: (a: BigNumber) => BigNumber,
  ): BigNumber {
    const tvl: BigNumber = this.totalTvl();
    return calcZero({
      f,
      df,
      initialGuessNewton: tvl,
      upperBoundBisect: tvl,
      ignoreNegativeResult: true,
      lazyLowerBoundBisect: this.geometricMeanDoubled.bind(this),
      lowerBoundBisect: undefined,
    });
  }

  // Finds and returns a zero for the given fn f (with its derivative df).
  // Uses guesses and bounds optimized for calculating the invariant as a fn of x
  private findZeroWithPool0Params(
    f: (a: BigNumber) => BigNumber,
    df: (a: BigNumber) => BigNumber,
  ): BigNumber {
    const xOverD = this.pool0Size.dividedBy(this.invariant);
    return calcZero({
      f,
      df,
      initialGuessNewton: xOverD,
      upperBoundBisect: xOverD,
      ignoreNegativeResult: false,
      lazyLowerBoundBisect: undefined,
      lowerBoundBisect: BigNumber(0),
    });
  }

  // Finds and returns a zero for the given fn f (with its derivative df)
  // Uses guesses and bounds optimized for calculating the invariant as a fn of y
  private findZeroWithPool1Params(
    f: (a: BigNumber) => BigNumber,
    df: (a: BigNumber) => BigNumber,
  ): BigNumber {
    const pyOverD = this.token1TvlInUnitsToken0().dividedBy(this.invariant);
    return calcZero({
      f,
      df,
      initialGuessNewton: pyOverD,
      upperBoundBisect: pyOverD,
      ignoreNegativeResult: false,
      lazyLowerBoundBisect: undefined,
      lowerBoundBisect: BigNumber(0),
    });
  }
}

/**
* returns output of a simulated swap from token0 to token1 using the constant
* product rule for non-stable pairs.
* The swap output is rounded to the nearest integer, so inputs should be in
* raw number form to prevent loss of precision
* */
function constantProductSwapToken0for1({
  token0LiquidityAmount,
  token1LiquidityAmount,
  token0InputAmount,
  fee,
}:{
  token0LiquidityAmount: BigNumber,
  token1LiquidityAmount: BigNumber,
  token0InputAmount: BigNumber,
  fee: BigNumber,
}) {
  // constant product rule
  const token1OutputAmount = token1LiquidityAmount.minus(
    token0LiquidityAmount.multipliedBy(token1LiquidityAmount)
      .dividedBy((token0LiquidityAmount.plus(token0InputAmount))),
  );

  // subtract fees after swap
  const realToken1outputAmount = token1OutputAmount.minus(token1OutputAmount.multipliedBy(fee));
  return BigNumber(realToken1outputAmount.toFixed(0));
}

/**
* returns input of a simulated swap from token0 to token1 using the constant
* product rule for non-stable pairs
* The swap output is rounded to the nearest integer, so inputs should be in
* raw number form to prevent loss of precision
* */
function constantProductReverseSwapToken0for1({
  token0LiquidityAmount,
  token1LiquidityAmount,
  token1OutputAmount,
  fee,
}:{
  token0LiquidityAmount: BigNumber,
  token1LiquidityAmount: BigNumber,
  token1OutputAmount: BigNumber,
  fee: BigNumber,
}) {
  if (token1OutputAmount.isGreaterThanOrEqualTo(token1LiquidityAmount)) {
    throw Error('Not enough liquidity for swap');
  }
  // constant product rule including fee applied after the trade
  const token0InputAmount = (token0LiquidityAmount.multipliedBy(
    token1LiquidityAmount,
  ).dividedBy(
    token1OutputAmount.dividedBy(BigNumber(1).minus(fee)).minus(token1LiquidityAmount),
  ).plus(token0LiquidityAmount)).multipliedBy(-1);
  return BigNumber(token0InputAmount.toFixed(0));
}

/**
* returns the price impact of a simulated swap of token 0 for token 1,
* Price impact is the difference between the current market price and the
* price you will actually pay.
* Inputs may either be in human readable or raw form. There is no rounding performed, therefore
* there is no risk of loss of precision
* */
function constantProductPriceImpactToken0for1({
  token0LiquidityAmount,
  token1LiquidityAmount,
  token0InputAmount,
}:{
  token0LiquidityAmount: BigNumber,
  token1LiquidityAmount: BigNumber,
  token0InputAmount: BigNumber,
}) {
  const marketPrice = token0LiquidityAmount.dividedBy(token1LiquidityAmount);
  const constantProduct = token0LiquidityAmount.multipliedBy(token1LiquidityAmount);
  const newToken0LiquidityAmount = token0LiquidityAmount.plus(token0InputAmount);
  const newToken1LiquidityAmount = constantProduct.dividedBy(newToken0LiquidityAmount);
  const amountToken1Received = token1LiquidityAmount.minus(newToken1LiquidityAmount);
  const paidPrice = token0InputAmount.dividedBy(amountToken1Received);

  const priceImpact = paidPrice.dividedBy(marketPrice).minus(1);
  return priceImpact;
}

/**
* returns output of a simulated swap from token1 to token0 using the constant
* product rule for non-stable pairs
* The swap output is rounded to the nearest integer, so inputs should be in
* raw number form to prevent loss of precision
* */
function constantProductSwapToken1for0({
  token0LiquidityAmount,
  token1LiquidityAmount,
  token1InputAmount,
  fee,
}:{
  token0LiquidityAmount: BigNumber,
  token1LiquidityAmount: BigNumber,
  token1InputAmount: BigNumber,
  fee: BigNumber,
}) {
  // constant product rule
  const token0OutputAmount = token0LiquidityAmount.minus(
    token0LiquidityAmount.multipliedBy(token1LiquidityAmount)
      .dividedBy(token1LiquidityAmount.plus(token1InputAmount)),
  );
  // subtract fees after swap
  const realtoken0OutputAmount = token0OutputAmount.minus(token0OutputAmount.multipliedBy(fee));
  return BigNumber(realtoken0OutputAmount.toFixed(0));
}

/**
* returns input of a simulated swap from token1 to token0 using the constant
* product rule for non-stable pairs
* The swap output is rounded to the nearest integer, so inputs should be in
* raw number form to prevent loss of precision
* */
function constantProductReverseSwapToken1for0({
  token0LiquidityAmount,
  token1LiquidityAmount,
  token0OutputAmount,
  fee,
}:{
  token0LiquidityAmount: BigNumber,
  token1LiquidityAmount: BigNumber,
  token0OutputAmount: BigNumber,
  fee: BigNumber,
}) {
  if (token0OutputAmount.isGreaterThanOrEqualTo(token0LiquidityAmount)) {
    throw Error('Not enough liquidity for swap');
  }

  // constant product rule including fee applied after the trade
  const token1InputAmount = (token1LiquidityAmount.multipliedBy(
    token0LiquidityAmount,
  ).dividedBy(
    token0OutputAmount.dividedBy(BigNumber(1).minus(fee)).minus(token0LiquidityAmount),
  ).plus(token1LiquidityAmount)).multipliedBy(-1);
  return BigNumber(token1InputAmount.toFixed(0));
}

/**
* returns the price impact of a simulated swap of token 1 for token 0,
* Price impact is the difference between the current market price and the
* price you will actually pay.
* Inputs may either be in human readable or raw form. There is no rounding performed, therefore
* there is no risk of loss of precision
* */
function constantProductPriceImpactToken1for0({
  token0LiquidityAmount,
  token1LiquidityAmount,
  token1InputAmount,
}:{
  token0LiquidityAmount: BigNumber,
  token1LiquidityAmount: BigNumber,
  token1InputAmount: BigNumber,
}) {
  const marketPrice = token1LiquidityAmount.dividedBy(token0LiquidityAmount);
  const constantProduct = token1LiquidityAmount.multipliedBy(token0LiquidityAmount);
  const newToken1LiquidityAmount = token1LiquidityAmount.plus(token1InputAmount);
  const newToken0LiquidityAmount = constantProduct.dividedBy(newToken1LiquidityAmount);
  const amountToken0Received = token0LiquidityAmount.minus(newToken0LiquidityAmount);
  const paidPrice = token1InputAmount.dividedBy(amountToken0Received);
  const priceImpact = paidPrice.dividedBy(marketPrice).minus(1);
  return priceImpact;
}

/**
* returns output of a simulated swap of token0 for token1 using the stableswap math
* inputs token amounts must be passsed in as human readable form
* */
function stableSwapToken0for1({
  inputToken0Amount,
  poolToken0Amount,
  poolToken1Amount,
  priceRatio,
  alpha,
  gamma1,
  gamma2,
  liquidityProviderFee,
  daoFee,
  minTradeSizeToken0For1,
  minTradeSizeToken1For0,
  priceImpactLimit,
}:{
  inputToken0Amount:BigNumber,
  poolToken0Amount: BigNumber,
  poolToken1Amount: BigNumber,
  priceRatio: BigNumber,
  alpha: BigNumber,
  gamma1: BigNumber,
  gamma2: BigNumber,
  liquidityProviderFee: BigNumber,
  daoFee: BigNumber,
  minTradeSizeToken0For1: BigNumber,
  minTradeSizeToken1For0: BigNumber,
  priceImpactLimit: BigNumber,
}) {
  function stableSwapConfig(): StableConfig {
    BigNumber.set({ DECIMAL_PLACES: 30 });
    return new StableConfig({
      pool0Size: poolToken0Amount,
      pool1Size: poolToken1Amount,
      priceRatio,
      alpha,
      gamma1,
      gamma2,
      lpFee: liquidityProviderFee,
      shadeDaoFee: daoFee,
      minTradeSize0For1: minTradeSizeToken0For1,
      minTradeSize1For0: minTradeSizeToken1For0,
      priceImpactLimit,
    });
  }

  const swap: StableConfig = stableSwapConfig();
  return swap.swapToken0WithToken1(inputToken0Amount);
}

/**
* returns input of a simulated swap of token0 for token1 using the stableswap math
* inputs token amounts must be passsed in as human readable form
* */
function stableReverseSwapToken0for1({
  outputToken1Amount,
  poolToken0Amount,
  poolToken1Amount,
  priceRatio,
  alpha,
  gamma1,
  gamma2,
  liquidityProviderFee,
  daoFee,
  minTradeSizeToken0For1,
  minTradeSizeToken1For0,
  priceImpactLimit,
}:{
  outputToken1Amount:BigNumber,
  poolToken0Amount: BigNumber,
  poolToken1Amount: BigNumber,
  priceRatio: BigNumber,
  alpha: BigNumber,
  gamma1: BigNumber,
  gamma2: BigNumber,
  liquidityProviderFee: BigNumber,
  daoFee: BigNumber,
  minTradeSizeToken0For1: BigNumber,
  minTradeSizeToken1For0: BigNumber,
  priceImpactLimit: BigNumber,
}) {
  function stableSwapConfig(): StableConfig {
    BigNumber.set({ DECIMAL_PLACES: 30 });
    return new StableConfig({
      pool0Size: poolToken0Amount,
      pool1Size: poolToken1Amount,
      priceRatio,
      alpha,
      gamma1,
      gamma2,
      lpFee: liquidityProviderFee,
      shadeDaoFee: daoFee,
      minTradeSize0For1: minTradeSizeToken0For1,
      minTradeSize1For0: minTradeSizeToken1For0,
      priceImpactLimit,
    });
  }

  // add fees before the reverse swap
  const totalFee = liquidityProviderFee.plus(daoFee);
  const outputWithFeesAdded = outputToken1Amount.dividedBy(BigNumber(1).minus(totalFee));

  const swap: StableConfig = stableSwapConfig();
  return swap.simulateReverseToken0WithToken1Trade(outputWithFeesAdded).tradeInput;
}

/**
* returns output of a simulated swap of token1 for token0 using the stableswap math
* inputs token amounts must be passsed in as human readable form
* */
function stableSwapToken1for0({
  inputToken1Amount,
  poolToken0Amount,
  poolToken1Amount,
  priceRatio,
  alpha,
  gamma1,
  gamma2,
  liquidityProviderFee,
  daoFee,
  minTradeSizeToken0For1,
  minTradeSizeToken1For0,
  priceImpactLimit,
}:{
  inputToken1Amount:BigNumber,
  poolToken0Amount: BigNumber,
  poolToken1Amount: BigNumber,
  priceRatio: BigNumber,
  alpha: BigNumber,
  gamma1: BigNumber,
  gamma2: BigNumber,
  liquidityProviderFee: BigNumber,
  daoFee: BigNumber,
  minTradeSizeToken0For1: BigNumber,
  minTradeSizeToken1For0: BigNumber,
  priceImpactLimit: BigNumber,
}) {
  function stableSwapConfig(): StableConfig {
    BigNumber.set({ DECIMAL_PLACES: 30 });
    return new StableConfig({
      pool0Size: poolToken0Amount,
      pool1Size: poolToken1Amount,
      priceRatio,
      alpha,
      gamma1,
      gamma2,
      lpFee: liquidityProviderFee,
      shadeDaoFee: daoFee,
      minTradeSize0For1: minTradeSizeToken0For1,
      minTradeSize1For0: minTradeSizeToken1For0,
      priceImpactLimit,
    });
  }

  const swap: StableConfig = stableSwapConfig();
  return swap.swapToken1WithToken0(inputToken1Amount);
}

/**
* returns output of a simulated swap of token1 for token0 using the stableswap math
* inputs token amounts must be passsed in as human readable form
* */
function stableReverseSwapToken1for0({
  outputToken0Amount,
  poolToken0Amount,
  poolToken1Amount,
  priceRatio,
  alpha,
  gamma1,
  gamma2,
  liquidityProviderFee,
  daoFee,
  minTradeSizeToken0For1,
  minTradeSizeToken1For0,
  priceImpactLimit,
}:{
  outputToken0Amount:BigNumber,
  poolToken0Amount: BigNumber,
  poolToken1Amount: BigNumber,
  priceRatio: BigNumber,
  alpha: BigNumber,
  gamma1: BigNumber,
  gamma2: BigNumber,
  liquidityProviderFee: BigNumber,
  daoFee: BigNumber,
  minTradeSizeToken0For1: BigNumber,
  minTradeSizeToken1For0: BigNumber,
  priceImpactLimit: BigNumber,
}) {
  function stableSwapConfig(): StableConfig {
    BigNumber.set({ DECIMAL_PLACES: 30 });
    return new StableConfig({
      pool0Size: poolToken0Amount,
      pool1Size: poolToken1Amount,
      priceRatio,
      alpha,
      gamma1,
      gamma2,
      lpFee: liquidityProviderFee,
      shadeDaoFee: daoFee,
      minTradeSize0For1: minTradeSizeToken0For1,
      minTradeSize1For0: minTradeSizeToken1For0,
      priceImpactLimit,
    });
  }
  // add fees before the reverse swap
  const totalFee = liquidityProviderFee.plus(daoFee);
  const outputWithFeesAdded = outputToken0Amount.dividedBy(BigNumber(1).minus(totalFee));
  const swap: StableConfig = stableSwapConfig();
  return swap.simulateReverseToken1WithToken0Trade(outputWithFeesAdded).tradeInput;
}

/**
* returns price impact of a simulated swap of token0 for token1
* inputs token amounts must be passsed in as human readable form
* */
function stableSwapPriceImpactToken0For1({
  inputToken0Amount,
  poolToken0Amount,
  poolToken1Amount,
  priceRatio,
  alpha,
  gamma1,
  gamma2,
  liquidityProviderFee,
  daoFee,
  minTradeSizeToken0For1,
  minTradeSizeToken1For0,
  priceImpactLimit,
}:{
  inputToken0Amount:BigNumber,
  poolToken0Amount: BigNumber,
  poolToken1Amount: BigNumber,
  priceRatio: BigNumber,
  alpha: BigNumber,
  gamma1: BigNumber,
  gamma2: BigNumber,
  liquidityProviderFee: BigNumber,
  daoFee: BigNumber,
  minTradeSizeToken0For1: BigNumber,
  minTradeSizeToken1For0: BigNumber,
  priceImpactLimit: BigNumber,
}) {
  function stableSwapConfig(): StableConfig {
    BigNumber.set({ DECIMAL_PLACES: 30 });
    return new StableConfig({
      pool0Size: poolToken0Amount,
      pool1Size: poolToken1Amount,
      priceRatio,
      alpha,
      gamma1,
      gamma2,
      lpFee: liquidityProviderFee,
      shadeDaoFee: daoFee,
      minTradeSize0For1: minTradeSizeToken0For1,
      minTradeSize1For0: minTradeSizeToken1For0,
      priceImpactLimit,
    });
  }

  const swap: StableConfig = stableSwapConfig();
  const marketPrice = swap.priceToken1();
  const amountToken1Received = swap.swapToken0WithToken1(inputToken0Amount);
  // Add trade fees back into the received amount because price impact is
  // measured prior to fees being taken out of the trade
  const amountToken1ReceivedNoTradeFee = amountToken1Received.dividedBy(
    BigNumber(1).minus(liquidityProviderFee.plus(daoFee)),
  );
  const paidPrice = inputToken0Amount.dividedBy(amountToken1ReceivedNoTradeFee);
  return paidPrice.dividedBy(marketPrice).minus(1);
}

/**
* returns price impact of a simulated swap of token1 for token0
* inputs token amounts must be passsed in as human readable form
* */
function stableSwapPriceImpactToken1For0({
  inputToken1Amount,
  poolToken0Amount,
  poolToken1Amount,
  priceRatio,
  alpha,
  gamma1,
  gamma2,
  liquidityProviderFee,
  daoFee,
  minTradeSizeToken0For1,
  minTradeSizeToken1For0,
  priceImpactLimit,
}:{
  inputToken1Amount:BigNumber,
  poolToken0Amount: BigNumber,
  poolToken1Amount: BigNumber,
  priceRatio: BigNumber,
  alpha: BigNumber,
  gamma1: BigNumber,
  gamma2: BigNumber,
  liquidityProviderFee: BigNumber,
  daoFee: BigNumber,
  minTradeSizeToken0For1: BigNumber,
  minTradeSizeToken1For0: BigNumber,
  priceImpactLimit: BigNumber,
}) {
  function stableSwapConfig(): StableConfig {
    BigNumber.set({ DECIMAL_PLACES: 30 });
    return new StableConfig({
      pool0Size: poolToken0Amount,
      pool1Size: poolToken1Amount,
      priceRatio,
      alpha,
      gamma1,
      gamma2,
      lpFee: liquidityProviderFee,
      shadeDaoFee: daoFee,
      minTradeSize0For1: minTradeSizeToken0For1,
      minTradeSize1For0: minTradeSizeToken1For0,
      priceImpactLimit,
    });
  }

  const swap: StableConfig = stableSwapConfig();
  const marketPrice = swap.priceToken0();
  const amountToken0Received = swap.swapToken1WithToken0(inputToken1Amount);
  // Add trade fees back into the received amount because price impact is
  // measured prior to fees being taken out of the trade
  const amountToken0ReceivedNoTradeFee = amountToken0Received.dividedBy(
    BigNumber(1).minus(liquidityProviderFee.plus(daoFee)),
  );
  const paidPrice = inputToken1Amount.dividedBy(amountToken0ReceivedNoTradeFee);
  return paidPrice.dividedBy(marketPrice).minus(1);
}

/**
 * function used to determine the decimals of a token given the contract address and a list
 * of token configs
 */
function getTokenDecimalsByTokenConfig(tokenContractAddress: string, tokens: TokensConfig) {
  const tokenConfigArr = tokens.filter(
    (token) => token.tokenContractAddress === tokenContractAddress,
  );

  if (tokenConfigArr.length === 0) {
    throw new Error(`token ${tokenContractAddress} not available`);
  }

  if (tokenConfigArr.length > 1) {
    throw new Error(`Duplicate ${tokenContractAddress} tokens found`);
  }
  // at this point we have determined there is a single match
  return tokenConfigArr[0].decimals;
}

/**
* retuns possible paths through one or multiple pools to complete a trade of two tokens
*/
function getPossiblePaths({
  inputTokenContractAddress,
  outputTokenContractAddress,
  maxHops,
  pairs,
}:{
  inputTokenContractAddress:string,
  outputTokenContractAddress:string,
  maxHops: number,
  pairs: BatchPairsInfo,
}) {
  // keeps track of the current path we are exploring
  const path: string[] = [];
  // keeps track of all the paths found from the starting token to the ending token
  const result: string[][] = [];
  // keeps track of the pools that have been visited to avoid loops
  const visited = new Set<string>();

  // depth-first search function
  function dfs(tokenContractAddress: string, depth: number) {
    // if the current depth exceeds the maximum number of hops, return
    if (depth > maxHops) {
      return;
    }

    // if we have reached the ending token, add the current path to the result and return
    if (tokenContractAddress === outputTokenContractAddress && depth !== 0) {
      result.push([...path]);
      return;
    }

    // iterate through all the pools
    Object.values(pairs).forEach((pair) => {
      const {
        pairContractAddress,
        pairInfo,
      } = pair;

      // if the current pool has already been visited, return
      if (visited.has(pairContractAddress)) {
        return;
      }

      // if the current pool contains the token we are currently exploring,
      // add it to the path and mark it as visited
      if (pairInfo.token0Contract.address === tokenContractAddress
        || pairInfo.token1Contract.address === tokenContractAddress) {
        path.push(pairContractAddress);
        visited.add(pairContractAddress);

        // if the token we are currently exploring is token0 in the current pool,
        // explore token1 tokenAddress
        if (pairInfo.token0Contract.address === tokenContractAddress) {
          dfs(pairInfo.token1Contract.address, depth + 1);
        } else {
          // if the token we are currently exploring is token1 in the current pool,
          // explore token0 next
          dfs(pairInfo.token0Contract.address, depth + 1);
        }

        // backtrack by removing the current pool from the path and marking it as unvisited
        visited.delete(pairContractAddress);
        path.pop();
      }
    });
  }

  // start exploring from the starting token
  dfs(inputTokenContractAddress, 0);
  return result;
}

/**
* calculates the estimated output of swapping through a route given an input token amount
* and also transforms the data collected in each pool into the Route data model
*/
function calculateRoute({
  inputTokenAmount,
  inputTokenContractAddress,
  path,
  pairs,
  tokens,
}:{
  inputTokenAmount: BigNumber,
  inputTokenContractAddress: string,
  path: string[],
  pairs: BatchPairsInfo,
  tokens: TokensConfig, // list of all possible swap tokens
}): Route {
  // calculate output of the route
  const routeCalculation = path.reduce((prev, poolContractAddress) => {
    const {
      // set previous pool swap output as the new input
      outputTokenContractAddress: currentTokenContractAddress,
      quoteOutputAmount: inputAmount,
      quoteShadeDaoFee,
      quotePriceImpact,
      quoteLPFee,
      gasMultiplier,
    } = prev;

    let swapAmountOutput;
    let swapPriceImpact;
    let poolMultiplier;

    const pairArr = pairs.filter(
      (pair) => pair.pairContractAddress === poolContractAddress,
    );
    if (pairArr.length === 0) {
      throw new Error(`Pair ${poolContractAddress} not available`);
    }

    if (pairArr.length > 1) {
      throw new Error(`Duplicate ${poolContractAddress} pairs found`);
    }

    // at this point we have determined there is a single match
    const pair = pairArr[0];

    const {
      pairInfo: {
        token0Contract,
        token1Contract,
        token0Amount,
        token1Amount,
        lpFee,
        daoFee,
        isStable,
        stableParams,
      },
    } = pair;
    // Convert pool liquidity from human readable to raw number for
    // constant product swap calculations
    // at this point we have determined there is a single match
    const poolToken0Decimals = getTokenDecimalsByTokenConfig(
      token0Contract.address,
      tokens,
    );
    const poolToken1Decimals = getTokenDecimalsByTokenConfig(
      token1Contract.address,
      tokens,
    );

    const poolToken0AmountHumanReadable = convertCoinFromUDenom(
      token0Amount,
      poolToken0Decimals,
    );
    const poolToken1AmountHumanReadable = convertCoinFromUDenom(
      token1Amount,
      poolToken1Decimals,
    );

    // converts input amount from raw number to human readable for use as an input
    // to the stableswap calculations.
    const inputTokenDecimals = getTokenDecimalsByTokenConfig(
      currentTokenContractAddress,
      tokens,
    );

    const inputAmountHumanReadable = convertCoinFromUDenom(
      inputAmount,
      inputTokenDecimals,
    );

    // determine token id of the output token in the swap
    let outputTokenContractAddress;
    if (currentTokenContractAddress === token0Contract.address) {
      outputTokenContractAddress = token1Contract.address;
    } else {
      outputTokenContractAddress = token0Contract.address;
    }

    // determine decimals of the output token
    const outputTokenDecimals = getTokenDecimalsByTokenConfig(
      outputTokenContractAddress,
      tokens,
    );

    // Stable Pool calculations
    if (isStable && stableParams) {
      poolMultiplier = GasMultiplier.STABLE;

      if (!stableParams.priceRatio) {
        throw new Error('PriceRatio not available: Oracle Error');
      }

      // token0 as the input
      if (currentTokenContractAddress === token0Contract.address) {
        const swapParams = {
          inputToken0Amount: inputAmountHumanReadable,
          poolToken0Amount: poolToken0AmountHumanReadable,
          poolToken1Amount: poolToken1AmountHumanReadable,
          priceRatio: BigNumber(stableParams.priceRatio),
          alpha: BigNumber(stableParams.alpha),
          gamma1: BigNumber(stableParams.gamma1),
          gamma2: BigNumber(stableParams.gamma2),
          liquidityProviderFee: BigNumber(lpFee),
          daoFee: BigNumber(daoFee),
          minTradeSizeToken0For1: BigNumber(stableParams.minTradeSizeXForY),
          minTradeSizeToken1For0: BigNumber(stableParams.minTradeSizeYForX),
          priceImpactLimit: BigNumber(stableParams.maxPriceImpactAllowed),
        };

        const swapAmountOutputHumanReadable = stableSwapToken0for1(swapParams);

        swapAmountOutput = BigNumber(convertCoinToUDenom(
          swapAmountOutputHumanReadable,
          outputTokenDecimals,
        ));
        swapPriceImpact = stableSwapPriceImpactToken0For1(swapParams);
      // token1 as the input
      } else if (currentTokenContractAddress === token1Contract.address) {
        const swapParams = {
          inputToken1Amount: inputAmountHumanReadable,
          poolToken0Amount: poolToken0AmountHumanReadable,
          poolToken1Amount: poolToken1AmountHumanReadable,
          priceRatio: BigNumber(stableParams.priceRatio),
          alpha: BigNumber(stableParams.alpha),
          gamma1: BigNumber(stableParams.gamma1),
          gamma2: BigNumber(stableParams.gamma2),
          liquidityProviderFee: BigNumber(lpFee),
          daoFee: BigNumber(daoFee),
          minTradeSizeToken0For1: BigNumber(stableParams.minTradeSizeXForY),
          minTradeSizeToken1For0: BigNumber(stableParams.minTradeSizeYForX),
          priceImpactLimit: BigNumber(stableParams.maxPriceImpactAllowed),
        };

        const swapAmountOutputHumanReadable = stableSwapToken1for0(swapParams);

        swapAmountOutput = BigNumber(convertCoinToUDenom(
          swapAmountOutputHumanReadable,
          outputTokenDecimals,
        ));
        swapPriceImpact = stableSwapPriceImpactToken1For0(swapParams);
      } else {
        throw Error('stableswap parameter error');
      }
    } else {
      poolMultiplier = GasMultiplier.CONSTANT_PRODUCT;
      // non-stable pools using constant product rule math
      // token0 as the input
      if (currentTokenContractAddress === token0Contract.address) {
        swapAmountOutput = constantProductSwapToken0for1({
          token0LiquidityAmount: BigNumber(token0Amount),
          token1LiquidityAmount: BigNumber(token1Amount),
          token0InputAmount: inputAmount,
          fee: BigNumber(lpFee).plus(daoFee),
        });

        swapPriceImpact = constantProductPriceImpactToken0for1({
          token0LiquidityAmount: BigNumber(token0Amount),
          token1LiquidityAmount: BigNumber(token1Amount),
          token0InputAmount: inputAmount,
        });
        // non-stable pools using constant product rule math
        // token1 as the input
      } else if (currentTokenContractAddress === token1Contract.address) {
        swapAmountOutput = constantProductSwapToken1for0({
          token0LiquidityAmount: BigNumber(token0Amount),
          token1LiquidityAmount: BigNumber(token1Amount),
          token1InputAmount: inputAmount,
          fee: BigNumber(lpFee).plus(daoFee),
        });

        swapPriceImpact = constantProductPriceImpactToken1for0({
          token0LiquidityAmount: BigNumber(token0Amount),
          token1LiquidityAmount: BigNumber(token1Amount),
          token1InputAmount: inputAmount,
        });
      } else {
        throw Error('constant product rule swap parameter error');
      }
    }

    // output data for the reduce function
    return {
      outputTokenContractAddress,
      quoteOutputAmount: swapAmountOutput,
      quoteShadeDaoFee: quoteShadeDaoFee.plus(daoFee),
      quoteLPFee: quoteLPFee.plus(lpFee),
      quotePriceImpact: quotePriceImpact.plus(swapPriceImpact),
      gasMultiplier: gasMultiplier + poolMultiplier,
    };

    // reduce function starting values
  }, {
    outputTokenContractAddress: inputTokenContractAddress,
    quoteOutputAmount: inputTokenAmount,
    quoteShadeDaoFee: BigNumber(0),
    quoteLPFee: BigNumber(0),
    quotePriceImpact: BigNumber(0),
    gasMultiplier: 0,
  });

  // formulate the Routes data model
  const {
    outputTokenContractAddress,
    quoteOutputAmount,
    quoteShadeDaoFee,
    quoteLPFee,
    quotePriceImpact,
    gasMultiplier,
  } = routeCalculation;

  return {
    inputAmount: inputTokenAmount,
    quoteOutputAmount,
    quoteShadeDaoFee,
    quoteLPFee,
    priceImpact: quotePriceImpact,
    inputTokenContractAddress,
    outputTokenContractAddress,
    path,
    gasMultiplier,
  };
}

/**
* retrieves all potential route options and the outputs of each route.
* returns an array of routes in the order that will give the highest quoted
* output amount
*/
function getRoutes({
  inputTokenAmount,
  inputTokenContractAddress,
  outputTokenContractAddress,
  maxHops,
  pairs,
  tokens,
}: {
  inputTokenAmount: BigNumber,
  inputTokenContractAddress: string,
  outputTokenContractAddress: string,
  maxHops: number,
  pairs: BatchPairsInfo,
  tokens: TokensConfig,
}) {
  // generates possible routes as the swap path
  const possiblePaths = getPossiblePaths({
    inputTokenContractAddress,
    outputTokenContractAddress,
    maxHops,
    pairs,
  });

  if (possiblePaths.length === 0) {
    return [];
  }

  const routes = possiblePaths.reduce((prev, path) => {
    try {
      const newRoute = calculateRoute({
        inputTokenAmount,
        inputTokenContractAddress,
        path,
        pairs,
        tokens,
      });
      prev.push(newRoute);
      return prev;
      // for any errors skip the path as a possible route
    } catch {
      return prev;
    }
  }, [] as Route[]);

  // returns routes in the order that maximizes the users output
  return routes.sort((a: Route, b: Route) => {
    // sort by output amounts

    if (a.quoteOutputAmount.isGreaterThan(b.quoteOutputAmount)) {
      return -1; // sort a before b
    }
    if (a.quoteOutputAmount.isLessThan(b.quoteOutputAmount)) {
      return 1; // sort a after b
    }
    return 0; // keep original order of a and b
  });
}
export {
  getPossiblePaths,
  calculateRoute,
  getRoutes,
};
