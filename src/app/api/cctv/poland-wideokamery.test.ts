import { describe, it, expect } from 'vitest';
import { WIDEOKAMERY_PL_CAMERAS } from './poland-wideokamery.generated';
import { fetchPolandCameras } from './poland';

/** Poland's rough bounding box — every camera in the catalogue is somewhere inside it. */
const IN_POLAND = (lat: number, lng: number) => lat > 49.0 && lat < 55.0 && lng > 14.1 && lng < 24.1;

describe('WIDEOKAMERY_PL_CAMERAS', () => {
  it('carries a meaningful number of cameras', () => {
    expect(WIDEOKAMERY_PL_CAMERAS.length).toBeGreaterThan(500);
  });

  it('places every camera inside Poland', () => {
    const outside = WIDEOKAMERY_PL_CAMERAS.filter((c) => !IN_POLAND(c.lat, c.lng));
    expect(outside).toEqual([]);
  });

  it('uses unique ids and unique Windy players', () => {
    const ids = new Set(WIDEOKAMERY_PL_CAMERAS.map((c) => c.id));
    const players = new Set(WIDEOKAMERY_PL_CAMERAS.map((c) => c.stream_url));
    expect(ids.size).toBe(WIDEOKAMERY_PL_CAMERAS.length);
    expect(players.size).toBe(WIDEOKAMERY_PL_CAMERAS.length);
  });

  it('serves each camera as a Windy iframe embed with a source page', () => {
    for (const cam of WIDEOKAMERY_PL_CAMERAS) {
      expect(cam.stream_type).toBe('iframe');
      expect(cam.stream_url).toMatch(/^https:\/\/webcams\.windy\.com\/webcams\/public\/embed\/player\/\d+\/day$/);
      expect(cam.external_url).toMatch(/^https:\/\/wideokamery\.pl\/kamery\//);
      expect(cam.name.length).toBeGreaterThan(0);
      expect(cam.city.length).toBeGreaterThan(0);
    }
  });
});

describe('fetchPolandCameras', () => {
  it('includes both the pre-existing sources and the wideokamery catalogue', async () => {
    const cameras = await fetchPolandCameras();
    const sources = new Set(cameras.map((c) => c.source));
    expect(sources.has('wideokamery.pl')).toBe(true);
    expect(sources.has('nadmorski24.pl')).toBe(true);
    expect(cameras.length).toBeGreaterThan(WIDEOKAMERY_PL_CAMERAS.length);
  });
});
