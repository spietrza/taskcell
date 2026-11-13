import { useEffect, useState } from 'react';

const IS_DEV = import.meta.env.DEV;

/** Dev-only overlay: viewport WxH readout (bottom-right, above the breakpoint badge) plus the Tailwind
 *  breakpoint badge (bottom-right corner, kept off the top bar's theme toggle; drawn by the `debug-screens` plugin). Renders nothing in production. */
export function TailwindDebugScreens() {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);

  useEffect(() => {
    if (IS_DEV && !document.body.classList.contains('debug-screens')) {
      document.body.classList.add('debug-screens');
    }
  }, []);

  useEffect(() => {
    if (!IS_DEV) return;
    const onResize = (): void => setSize({ width: window.innerWidth, height: window.innerHeight });
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  if (!IS_DEV || !size) return null;

  return (
    <div className="fixed bottom-6 right-0 z-50 pointer-events-none bg-background px-4 py-2 text-[10px] text-foreground">
      {size.width}x{size.height}
    </div>
  );
}
