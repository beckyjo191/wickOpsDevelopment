import { useEffect, useMemo, useState } from "react";

const MAX_VISIBLE_DESKTOP = 6;
const MAX_VISIBLE_MOBILE = 3;

interface LocationBadge {
  location: string;
  badge?: number;
}

interface LocationPillsProps {
  locations: LocationBadge[];
  selectedLocation: string | null;
  onLocationChange: (location: string) => void;
  /** Extra content rendered after the pills (e.g. "+ add" button) */
  children?: React.ReactNode;
  /** Optional label shown before pills */
  label?: string;
}

export function LocationPills({
  locations,
  selectedLocation,
  onLocationChange,
  children,
  label,
}: LocationPillsProps) {
  const [isMobile, setIsMobile] = useState(() => window.matchMedia("(max-width: 780px)").matches);
  const [showAll, setShowAll] = useState(false);
  const [search, setSearch] = useState("");

  useEffect(() => {
    const mql = window.matchMedia("(max-width: 780px)");
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);

  const maxVisible = isMobile ? MAX_VISIBLE_MOBILE : MAX_VISIBLE_DESKTOP;

  // Always show the active location in visible pills even if it would overflow
  const { visible, overflow } = useMemo(() => {
    if (locations.length <= maxVisible) {
      return { visible: locations, overflow: [] as LocationBadge[] };
    }

    const activeIndex = locations.findIndex((l) => l.location === selectedLocation);
    const vis: LocationBadge[] = [];
    const ovf: LocationBadge[] = [];

    // Reserve one slot for the "+N more" pill
    const slotsForPills = maxVisible - 1;

    for (let i = 0; i < locations.length; i++) {
      if (i < slotsForPills || i === activeIndex) {
        vis.push(locations[i]);
      } else {
        ovf.push(locations[i]);
      }
    }

    // If active was already in the first slots, overflow might have fewer
    // Re-check: if visible exceeds slots+1 (active was in overflow range), trim
    if (vis.length > maxVisible) {
      // Active was added beyond the slots — remove the last non-active from visible
      const lastSlotIndex = vis.findIndex(
        (_, idx) => idx === slotsForPills - 1 && vis[idx].location !== selectedLocation,
      );
      if (lastSlotIndex >= 0) {
        const [removed] = vis.splice(lastSlotIndex, 1);
        ovf.unshift(removed);
      }
    }

    return { visible: vis, overflow: ovf };
  }, [locations, maxVisible, selectedLocation]);

  const filteredOverflow = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return overflow;
    return overflow.filter((l) => l.location.toLowerCase().includes(q));
  }, [overflow, search]);

  return (
    <>
      <div className="location-pills">
        {label ? <span className="location-pills-label">{label}</span> : null}
        {visible.map((loc) => (
          <button
            key={loc.location}
            type="button"
            className={`location-pill${selectedLocation === loc.location ? " active" : ""}`}
            onClick={() => onLocationChange(loc.location)}
          >
            {loc.location}
            {loc.badge != null && loc.badge > 0 ? (
              <span className="location-pill-badge">{loc.badge}</span>
            ) : null}
          </button>
        ))}
        {overflow.length > 0 ? (
          <button
            type="button"
            className={`location-pill location-pill--more${overflow.some((l) => l.location === selectedLocation) ? " active" : ""}`}
            onClick={() => { setShowAll(true); setSearch(""); }}
          >
            +{overflow.length} more
          </button>
        ) : null}
        {children}
      </div>

      {showAll ? (
        <div className="settings-destructive-overlay">
          <div className="settings-destructive-backdrop" onClick={() => setShowAll(false)} />
          <div className="location-overflow-sheet" role="dialog" aria-label="All locations">
            <div className="location-overflow-sheet-header">
              <h3 className="location-overflow-sheet-title">Locations</h3>
              <button
                type="button"
                className="location-overflow-sheet-close"
                onClick={() => setShowAll(false)}
                aria-label="Close"
              >
                ×
              </button>
            </div>
            {overflow.length > 5 ? (
              <input
                type="text"
                className="location-overflow-search"
                placeholder="Search locations..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                autoFocus
              />
            ) : null}
            <div className="location-overflow-list">
              {filteredOverflow.length === 0 ? (
                <p className="location-overflow-empty">No matching locations.</p>
              ) : (
                filteredOverflow.map((loc) => (
                  <button
                    key={loc.location}
                    type="button"
                    className={`location-overflow-item${selectedLocation === loc.location ? " active" : ""}`}
                    onClick={() => {
                      onLocationChange(loc.location);
                      setShowAll(false);
                    }}
                  >
                    <span>{loc.location}</span>
                    {loc.badge != null && loc.badge > 0 ? (
                      <span className="location-pill-badge">{loc.badge}</span>
                    ) : null}
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
