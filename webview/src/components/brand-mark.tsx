export function BrandMark({ size = 28 }: { size?: number }) {
	return <svg width={size} height={size} viewBox="0 0 256 256" aria-hidden="true" focusable="false">
		<defs><linearGradient id="brand-bg" x1="0" y1="0" x2="1" y2="1"><stop stopColor="#17263e" /><stop offset="1" stopColor="#070b17" /></linearGradient><linearGradient id="brand-orbit" x1="0" y1="0" x2="1" y2="1"><stop stopColor="#73ecf2" /><stop offset="1" stopColor="#8f9cff" /></linearGradient></defs>
		<rect x="10" y="10" width="236" height="236" rx="55" fill="url(#brand-bg)" />
		<rect x="11" y="11" width="234" height="234" rx="54" fill="none" stroke="#63809f" strokeOpacity=".35" strokeWidth="2" />
		<g fill="none" stroke="url(#brand-orbit)" strokeWidth="10" strokeLinecap="round"><ellipse cx="128" cy="128" rx="86" ry="37" transform="rotate(-39 128 128)" /><path d="M88 202c-26-27-31-70-13-107" opacity=".74" /></g>
		<path d="M128 91 147 128 128 165 109 128Z" fill="#eefaff" /><path d="M128 91v74l19-37Z" fill="#91d9fb" />
		<circle cx="185" cy="61" r="11" fill="#effcff" /><circle cx="185" cy="61" r="5" fill="#76e8f0" />
	</svg>;
}
