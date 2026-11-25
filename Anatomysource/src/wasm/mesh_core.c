#include <math.h>

static float fit_result[7];

// Returns center (x,y,z), uniform fit scale, and source extents (x,y,z).
// The viewer keeps coordinates in the source file's units; this is a display fit.
__attribute__((used, visibility("default")))
float *compute_fit(float min_x, float min_y, float min_z,
                   float max_x, float max_y, float max_z) {
  const float width = max_x - min_x;
  const float height = max_y - min_y;
  const float depth = max_z - min_z;
  float largest = width;
  if (height > largest) largest = height;
  if (depth > largest) largest = depth;

  fit_result[0] = (min_x + max_x) * 0.5f;
  fit_result[1] = (min_y + max_y) * 0.5f;
  fit_result[2] = (min_z + max_z) * 0.5f;
  fit_result[3] = largest > 0.000001f ? 2.0f / largest : 1.0f;
  fit_result[4] = width;
  fit_result[5] = height;
  fit_result[6] = depth;
  return fit_result;
}
