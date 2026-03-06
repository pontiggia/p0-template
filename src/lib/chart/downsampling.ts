interface DataPoint {
  x: number;
  y: number;
}

export function lttbDownsample(
  data: DataPoint[],
  threshold: number,
): DataPoint[] {
  if (threshold >= data.length || threshold < 3) {
    return data;
  }

  const sampled: DataPoint[] = [];
  const bucketSize = (data.length - 2) / (threshold - 2);

  sampled.push(data[0]);

  for (let i = 0; i < threshold - 2; i++) {
    const bucketStart = Math.floor((i + 1) * bucketSize) + 1;
    const bucketEnd = Math.min(
      Math.floor((i + 2) * bucketSize) + 1,
      data.length,
    );

    let avgX = 0;
    let avgY = 0;
    const nextBucketStart = Math.floor((i + 2) * bucketSize) + 1;
    const nextBucketEnd = Math.min(
      Math.floor((i + 3) * bucketSize) + 1,
      data.length,
    );

    for (let j = nextBucketStart; j < nextBucketEnd; j++) {
      avgX += data[j].x;
      avgY += data[j].y;
    }
    const nextBucketSize = nextBucketEnd - nextBucketStart;
    avgX /= nextBucketSize;
    avgY /= nextBucketSize;

    let maxArea = -1;
    let maxAreaIndex = bucketStart;
    const prevPoint = sampled[sampled.length - 1];

    for (let j = bucketStart; j < bucketEnd; j++) {
      const area =
        Math.abs(
          (prevPoint.x - avgX) * (data[j].y - prevPoint.y) -
            (prevPoint.x - data[j].x) * (avgY - prevPoint.y),
        ) * 0.5;

      if (area > maxArea) {
        maxArea = area;
        maxAreaIndex = j;
      }
    }

    sampled.push(data[maxAreaIndex]);
  }

  sampled.push(data[data.length - 1]);
  return sampled;
}

export function downsampleChartData<T extends Record<string, unknown>>(
  data: T[],
  xKey: string,
  yKey: string,
  threshold = 500,
): T[] {
  if (data.length <= threshold) return data;

  const points: DataPoint[] = data.map((d, i) => ({
    x: typeof d[xKey] === 'number' ? d[xKey] : i,
    y: typeof d[yKey] === 'number' ? d[yKey] : 0,
  }));

  const sampled = lttbDownsample(points, threshold);

  // Map back to original indices
  const sampledIndices = new Set(
    sampled.map((p) => points.findIndex((op) => op.x === p.x && op.y === p.y)),
  );

  return data.filter((_, i) => sampledIndices.has(i));
}
