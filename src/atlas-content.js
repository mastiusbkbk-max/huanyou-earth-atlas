import { places as chinaPlaces, chapters as chinaChapters, sources as chinaSources, themes as chinaThemes } from './content.js';
import { placeStories as chinaStories } from './place-stories.js';
import { worldPlaces, worldStories, worldChapters, worldSources } from './content-world.js';

export const places = [...worldPlaces, ...chinaPlaces.map(place => ({ ...place, country: '中国', continent: '亚洲' }))];
export const placeStories = { ...chinaStories, ...worldStories };
export const chapters = [...worldChapters, ...chinaChapters];
export const sources = [...worldSources, ...chinaSources];
export const themes = chinaThemes.map(theme => theme.id === 'gardens' ? { ...theme, label: '园林生态' } : theme);
export const countryNames = [...new Set(places.map(place => place.country))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
export const continents = ['亚洲', '欧洲', '非洲', '北美洲', '南美洲', '大洋洲'];
export const highlights = ['world-eiffel', 'world-colosseum', 'world-giza', 'world-petra', 'world-taj-mahal', 'world-fuji', 'everest', 'world-sydney-opera', 'world-grand-canyon', 'world-machu-picchu', 'world-iguazu', 'world-milford-sound'];

export function matchesScope(place, continent = 'all', country = 'all') {
  return (continent === 'all' || place.continent === continent) && (country === 'all' || place.country === country);
}

export function coordinateLabel([longitude, latitude]) {
  return `${Math.abs(latitude).toFixed(2)}° ${latitude < 0 ? 'S' : 'N'} / ${Math.abs(longitude).toFixed(2)}° ${longitude < 0 ? 'W' : 'E'}`;
}
