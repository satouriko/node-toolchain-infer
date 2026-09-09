interface Segment {
  lower: string
  upper?: string
}
/** Only stable releases contribute compatibility intervals. */
export function compileRanges(intervals: Segment[]): string {
  return intervals.map(({ lower, upper }) => `>=${lower}${upper ? ` <${upper}` : ''}`).join(' || ')
}
