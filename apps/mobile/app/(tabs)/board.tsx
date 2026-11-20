import type { ReactNode } from 'react';
import { BoardScreen } from '../../src/BoardScreen';
import { useSession } from '../../src/session';

export default function Board(): ReactNode {
  const { credentials } = useSession();
  return credentials ? <BoardScreen credentials={credentials} /> : null;
}
