import { useColorScheme } from 'react-native';
import { themeFor, type Theme } from './theme';

export const useTheme = (): Theme => themeFor(useColorScheme());
