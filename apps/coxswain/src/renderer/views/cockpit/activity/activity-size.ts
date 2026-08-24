export const DEFAULT_ACTIVITY_WIDTH = 380;
export const MIN_ACTIVITY_WIDTH = 260;
export const MAX_ACTIVITY_WIDTH = 720;
export const MIN_CONVERSATION_WIDTH = 320;

export function activityWidthLimit(containerWidth: number): number {
  return Math.max(
    MIN_ACTIVITY_WIDTH,
    Math.min(MAX_ACTIVITY_WIDTH, containerWidth - MIN_CONVERSATION_WIDTH),
  );
}

export function clampActivityWidth(width: number, containerWidth: number): number {
  return Math.round(Math.min(
    activityWidthLimit(containerWidth),
    Math.max(MIN_ACTIVITY_WIDTH, width),
  ));
}

export function draggedActivityWidth(
  startingWidth: number,
  startingClientX: number,
  currentClientX: number,
  containerWidth: number,
): number {
  return clampActivityWidth(
    startingWidth + startingClientX - currentClientX,
    containerWidth,
  );
}
