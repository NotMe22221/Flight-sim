import { describe, expect, it } from 'vitest';
import { DEFAULT_ELEVATION_CHAIN, DEFAULT_IMAGERY_CHAIN, awsTerrarium, collectAttribution, eoxS2Cloudless2016, eoxS2Cloudless2023, gibsBlueMarble, mapterhorn, proceduralElevation, proceduralImagery } from './providers';

describe('providers', () => {
  it('URL templates render exactly', () => {
    expect(awsTerrarium.url(15, 5246, 12684)).toBe('https://s3.amazonaws.com/elevation-tiles-prod/terrarium/15/5246/12684.png');
    expect(mapterhorn.url(12, 655, 1585)).toBe('https://tiles.mapterhorn.com/12/655/1585.webp');
    // EOX WMTS REST order is {z}/{y}/{x} (TileMatrix/TileRow/TileCol)
    expect(eoxS2Cloudless2016.url(14, 2623, 6342)).toBe('https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/14/6342/2623.jpg');
    expect(eoxS2Cloudless2023.url(14, 2623, 6342)).toBe('https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2023_3857/default/g/14/6342/2623.jpg');
    expect(gibsBlueMarble.url(8, 40, 99)).toBe('https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/8/99/40.jpg');
    expect(proceduralElevation.url(3, 1, 2)).toBe('procedural://elevation/3/1/2');
    expect(proceduralImagery.url(3, 1, 2)).toBe('procedural://imagery/3/1/2');
  });

  it('zoom ranges and attribution', () => {
    expect([awsTerrarium.minZoom, awsTerrarium.maxZoom]).toEqual([0, 15]);
    expect(mapterhorn.maxZoom).toBe(12);
    expect(eoxS2Cloudless2016.maxZoom).toBe(14);
    expect(gibsBlueMarble.maxZoom).toBe(8);
    expect(gibsBlueMarble.minZoom).toBe(1);
    for (const p of [...DEFAULT_ELEVATION_CHAIN, ...DEFAULT_IMAGERY_CHAIN, eoxS2Cloudless2023]) {
      expect(p.attribution.length).toBeGreaterThan(0);
      expect(p.license.length).toBeGreaterThan(0);
      expect(p.tileSize === 256 || p.tileSize === 512).toBe(true);
    }
    expect(eoxS2Cloudless2016.license).toBe('CC BY 4.0');
    expect(eoxS2Cloudless2023.license).toContain('NC');
    expect(awsTerrarium.attribution.some((s) => s.includes('U.S. Geological Survey'))).toBe(true);
    const all = collectAttribution([awsTerrarium, awsTerrarium, eoxS2Cloudless2016]);
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBe(awsTerrarium.attribution.length + 1);
  });
});
