// Bug: returns sum instead of average
export function average(numbers: number[]): number {
  const sum = numbers.reduce((a, b) => a + b, 0);
  return sum; // BUG: should be sum / numbers.length
}
