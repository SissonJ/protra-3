import BigNumber from 'bignumber.js';

// Core CPMM swap function
export function cppm(
  baseIn: BigNumber,
  base: BigNumber,
  x: BigNumber,
  fee: BigNumber
): BigNumber {
  const xOut = x.minus(base.times(x).div(base.plus(baseIn)));
  const feeAmount = xOut.times(fee);
  return xOut.minus(feeAmount);
}

// Chained CPMM swap with 3 steps
export function cppm3(
  baseIn: BigNumber,
  base0: BigNumber,
  x0: BigNumber,
  fee0: BigNumber,
  x1: BigNumber,
  y1: BigNumber,
  fee1: BigNumber,
  y2: BigNumber,
  base2: BigNumber,
  fee2: BigNumber
): BigNumber {
  const xOut = cppm(baseIn, base0, x0, fee0);
  const yOut = cppm(xOut, x1, y1, fee1);
  const baseOut = cppm(yOut, y2, base2, fee2);
  return baseOut.minus(baseIn);
}

export function computeBaseIn(
  base0: BigNumber,
  x0: BigNumber,
  fee0: BigNumber,
  x1: BigNumber,
  y1: BigNumber,
  fee1: BigNumber,
  y2: BigNumber,
  base2: BigNumber,
  fee2: BigNumber
): { baseIn1: BigNumber; baseIn2: BigNumber } {
  const one = new BigNumber(1);

  const term1 = base0.times(x1).times(y2);

  const f = base0.times(base2).times(fee0).minus(base0.times(base2));
  const f1 = f.times(fee1);
  const f2 = f.minus(f1).times(fee2);
  const sqrtNumerator = f.minus(f1).minus(f2)
    .times(x0)
    .times(x1)
    .times(y1)
    .times(y2)
    .negated();

  const sqrtPart = sqrtNumerator.sqrt();

  const denominator = fee0.minus(one)
    .times(fee1)
    .minus(fee0)
    .plus(one)
    .times(x0)
    .times(y1)
    .minus(fee0.minus(one).times(x0).minus(x1).times(y2));

  const baseIn1 = term1.plus(sqrtPart).negated().div(denominator);
  const baseIn2 = term1.minus(sqrtPart).negated().div(denominator);

  return {
   baseIn1, 
   baseIn2 
  };
}
