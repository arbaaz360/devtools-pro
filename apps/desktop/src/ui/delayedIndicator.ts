/** Presentation-only timer. Changing/finishing a job invalidates its callback. */
export function delayedIndicator(setVisible: (visible: boolean) => void, delay = 200) {
  let current: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reset = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    setVisible(false);
  };
  return {
    update(key: string | null) {
      if (key === current) return;
      reset();
      current = key;
      if (key !== null) timer = setTimeout(() => {
        timer = undefined;
        if (current === key) setVisible(true);
      }, delay);
    },
    dispose() { current = null; reset(); },
  };
}
