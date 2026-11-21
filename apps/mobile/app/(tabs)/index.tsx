import type { ReactNode } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { HomeScreen } from '../../src/HomeScreen';
import { useSession } from '../../src/session';

export default function Home(): ReactNode {
  const { credentials } = useSession();
  const { open, repoName, nk } = useLocalSearchParams<{ open?: string; repoName?: string; nk?: string }>();
  return credentials ? <HomeScreen credentials={credentials} {...(open && nk ? { openItem: { id: open, repoName: repoName ?? '', key: nk } } : {})} /> : null;
}
