// Adapted from https://stackoverflow.com/questions/34848505/how-to-make-a-loading-animation-in-console-application-written-in-javascript-or

/**
 * Create and display a loader in the console.
 *
 * @param {string} [text=""] Text to display after loader
 * @param {array.<string>} [chars=["⠙", "⠘", "⠰", "⠴", "⠤", "⠦", "⠆", "⠃", "⠋", "⠉"]]
 * Array of characters representing loader steps
 * @param {number} [delay=100] Delay in ms between loader steps
 * @example
 * let loader = loadingAnimation("Loading…");
 *
 * // Stop loader after 1 second
 * setTimeout(() => clearInterval(loader), 1000);
 * @returns {number} An interval that can be cleared to stop the animation
 */
export function loadingAnimation(
  text: string = '',
  chars: Array<string> = ['⠙', '⠘', '⠰', '⠴', '⠤', '⠦', '⠆', '⠃', '⠋', '⠉'],
  delay: number = 100
) {
  let x = 0;

  return setInterval(function () {
    process.stdout.write('\r' + chars[x++] + ' ' + text);
    x = x % chars.length;
  }, delay);
}
