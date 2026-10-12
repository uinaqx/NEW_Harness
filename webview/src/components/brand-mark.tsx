/** One orbit and one core: readable at small sidebar and taskbar sizes. */
export function BrandMark({ size = 28 }: { size?: number }) {
	return <svg width={size} height={size} viewBox="0 0 256 256" aria-hidden="true" focusable="false">
		<rect x="8" y="8" width="240" height="240" rx="58" fill="var(--brand-bg-b, #191d24)" />
		<ellipse cx="128" cy="128" rx="84" ry="43" transform="rotate(-40 128 128)" fill="none" stroke="var(--brand-core, #f3f5f7)" strokeWidth="13" />
		<circle cx="128" cy="128" r="20" fill="var(--brand-core, #f3f5f7)" />
	</svg>;
}
