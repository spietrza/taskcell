import type { ComponentProps } from 'react';
import { Button as KitButton } from 'chunks-ui';

/**
 * The kit's Button, neutral by default. Orange means "needs you" only (DESIGN.md, The Orange Rule), so a
 * button is orange only where it says `color="primary"`: merging, answering, approving.
 */
export function Button({ color = 'secondary', ...props }: ComponentProps<typeof KitButton>) {
  return <KitButton color={color} {...props} />;
}
