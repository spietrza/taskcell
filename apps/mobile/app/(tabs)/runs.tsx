import type { ReactNode } from 'react';
import { RunsScreen } from '../../src/RunsScreen';
import { useSession } from '../../src/session';

export default function Runs(): ReactNode {
  const { credentials } = useSession();
  return credentials ? <RunsScreen /> : null;
}
