/**
 * Project Aegis - Human-Realistic Bezier Curve Mouse Trajectory Simulator
 * 
 * Implements:
 * - Issue #21: CORE-06 Human-Realistic Bezier Curve Mouse Trajectory Simulator
 */

export interface Point {
  x: number;
  y: number;
}

export interface TrajectoryPoint extends Point {
  timestamp: number; // millisecond timestamp relative to trajectory start
  pressure?: number;
}

export interface TrajectoryOptions {
  targetWidth?: number; // Target element width for Fitts's law (default: 20px)
  targetHeight?: number; // Target element height
  overshootProbability?: number; // Probability of overshooting target (default: 0.35)
  tremorMagnitude?: number; // Micro-tremor amplitude in pixels (default: 0.8)
  speedMultiplier?: number; // 1.0 = normal human speed, >1 = faster (default: 1.0)
}

/**
 * Computes a realistic multi-point mouse trajectory simulating human motor control,
 * kinematic acceleration, Fitts's Law, and physiological tremors.
 */
export class MouseTrajectoryGenerator {
  /**
   * Generates a list of timed waypoints from start to target.
   */
  public static generateTrajectory(
    start: Point,
    target: Point,
    options: TrajectoryOptions = {}
  ): TrajectoryPoint[] {
    const targetW = options.targetWidth ?? 24;
    const overshootProb = options.overshootProbability ?? 0.35;
    const tremor = options.tremorMagnitude ?? 0.8;
    const speed = options.speedMultiplier ?? 1.0;

    const dx = target.x - start.x;
    const dy = target.y - start.y;
    const distance = Math.hypot(dx, dy);

    // If movement is negligible, return minimal trajectory
    if (distance < 2) {
      return [
        { x: start.x, y: start.y, timestamp: 0 },
        { x: target.x, y: target.y, timestamp: 15 }
      ];
    }

    // Fitts's Law duration estimate: T = a + b * log2(1 + D/W)
    // a ~= 100ms, b ~= 120ms for average human mouse usage
    const fittsDuration = (100 + 120 * Math.log2(1 + distance / targetW)) / speed;
    const duration = Math.max(120, Math.min(800, fittsDuration));

    // Determine if trajectory should overshoot
    const willOvershoot = Math.random() < overshootProb && distance > 50;
    const overshootDistance = willOvershoot ? (Math.random() * 8 + 4) : 0;
    const angle = Math.atan2(dy, dx);

    const effectiveTarget: Point = willOvershoot
      ? {
          x: target.x + Math.cos(angle) * overshootDistance,
          y: target.y + Math.sin(angle) * overshootDistance
        }
      : target;

    // Generate cubic Bezier control points with perpendicular curve bias
    const perpAngle = angle + (Math.random() > 0.5 ? 1 : -1) * (Math.PI / 2);
    const curveAmount = (Math.random() * 0.3 + 0.1) * distance;

    const p1: Point = {
      x: start.x + dx * 0.25 + Math.cos(perpAngle) * curveAmount * (Math.random() * 0.8 + 0.4),
      y: start.y + dy * 0.25 + Math.sin(perpAngle) * curveAmount * (Math.random() * 0.8 + 0.4)
    };

    const p2: Point = {
      x: start.x + dx * 0.75 + Math.cos(perpAngle) * curveAmount * (Math.random() * 0.5 + 0.2),
      y: start.y + dy * 0.75 + Math.sin(perpAngle) * curveAmount * (Math.random() * 0.5 + 0.2)
    };

    // Calculate number of steps (standard human mouse sample rate ~60-120Hz = 8-16ms per step)
    const stepInterval = 12; // ms
    const totalSteps = Math.max(8, Math.round(duration / stepInterval));
    const points: TrajectoryPoint[] = [];

    for (let step = 0; step <= totalSteps; step++) {
      const rawT = step / totalSteps;
      // Human kinematic bell-shaped velocity profile: smoothstep or cubic ease-out
      const t = MouseTrajectoryGenerator.kinematicEase(rawT);

      // Cubic Bezier interpolation
      const basePoint = MouseTrajectoryGenerator.cubicBezier(start, p1, p2, effectiveTarget, t);

      // Physiological tremor (high frequency Gaussian micro-jitter, zero at step 0)
      const currentTremor = step === 0 ? 0 : (1 - rawT * 0.5) * tremor;
      const jitterX = (Math.random() - 0.5) * 2 * currentTremor;
      const jitterY = (Math.random() - 0.5) * 2 * currentTremor;

      const elapsed = Math.round(rawT * duration);

      points.push({
        x: Math.round((basePoint.x + jitterX) * 10) / 10,
        y: Math.round((basePoint.y + jitterY) * 10) / 10,
        timestamp: elapsed
      });
    }

    // If overshoot occurred, append corrective glide to the exact target
    if (willOvershoot) {
      const lastPoint = points[points.length - 1];
      const correctionSteps = 4;
      const correctionDuration = 60 + Math.random() * 40;

      for (let c = 1; c <= correctionSteps; c++) {
        const ct = c / correctionSteps;
        const easedCt = ct * ct; // Quadratic decelerating correction
        points.push({
          x: Math.round((lastPoint.x + (target.x - lastPoint.x) * easedCt) * 10) / 10,
          y: Math.round((lastPoint.y + (target.y - lastPoint.y) * easedCt) * 10) / 10,
          timestamp: Math.round(duration + ct * correctionDuration)
        });
      }
    } else {
      // Ensure exact arrival at destination
      points[points.length - 1].x = target.x;
      points[points.length - 1].y = target.y;
    }

    return points;
  }

  /**
   * Evaluates cubic Bezier curve at parameter t in [0, 1].
   */
  private static cubicBezier(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
    const u = 1 - t;
    const tt = t * t;
    const uu = u * u;
    const uuu = uu * u;
    const ttt = tt * t;

    return {
      x: uuu * p0.x + 3 * uu * t * p1.x + 3 * u * tt * p2.x + ttt * p3.x,
      y: uuu * p0.y + 3 * uu * t * p1.y + 3 * u * tt * p2.y + ttt * p3.y
    };
  }

  /**
   * Realistic human kinematic movement profile with smooth acceleration and gentle deceleration.
   */
  private static kinematicEase(t: number): number {
    // Quartic ease in-out
    return t < 0.5 ? 8 * t * t * t * t : 1 - Math.pow(-2 * t + 2, 4) / 2;
  }
}
