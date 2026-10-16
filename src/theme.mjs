export const THEME_STORAGE_KEY = 'arg.autopistas.theme';
export function resolveTheme(stored, prefersDark = false) {
  return stored === 'light' || stored === 'dark' ? stored : prefersDark ? 'dark' : 'light';
}
export function themeColors(theme) {
  return theme === 'dark'
    ? { accent: '#c895d9', ink: '#ded6cd', surface: '#252b28', halo: '#1b211f', context: '#918c81' }
    : { accent: '#9158a2', ink: '#64605f', surface: '#fdfbf7', halo: '#fdfbf7', context: '#ada192' };
}
export function basemapTiles(theme, reference = false) {
  const tone = theme === 'dark' ? 'Dark' : 'Light';
  return [`https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_${tone}_Gray_${reference ? 'Reference' : 'Base'}/MapServer/tile/{z}/{y}/{x}`];
}
