import type { ReactNode } from 'react';
import { HomeScreen } from '../../src/HomeScreen';
import { useSession } from '../../src/session';

export default function Home(): ReactNode {
  const { credentials } = useSession();
  return credentials ? <HomeScreen credentials={credentials} /> : null;
}
