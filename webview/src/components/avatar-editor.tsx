import { useEffect, useRef, useState } from "react";
import { Check, Upload, X } from "lucide-react";
import { AvatarVisual, AVATAR_PRESETS } from "./avatar-visual";

const VIEW = 220;
type Crop = { src: string; width: number; height: number; zoom: number; x: number; y: number };

function placement(width: number, height: number, zoom: number) {
	const scale = Math.max(VIEW / width, VIEW / height) * zoom;
	return { width: width * scale, height: height * scale };
}

export function AvatarEditor({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => Promise<void> }) {
	const input = useRef<HTMLInputElement>(null);
	const image = useRef<HTMLImageElement | null>(null);
	const drag = useRef<{ x: number; y: number; fromX: number; fromY: number } | null>(null);
	const [crop, setCrop] = useState<Crop | null>(null);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => () => { if (crop?.src) URL.revokeObjectURL(crop.src); }, [crop?.src]);
	const openFile = (file?: File) => {
		if (!file) return;
		if (!/^image\/(png|jpeg|webp)$/.test(file.type) || file.size > 8 * 1024 * 1024) { setError("请选择 8 MB 以内的 PNG、JPEG 或 WebP 图片。"); return; }
		const src = URL.createObjectURL(file);
		const img = new Image();
		img.onload = () => {
			image.current = img;
			const dimensions = placement(img.naturalWidth, img.naturalHeight, 1);
			setCrop({ src, width: img.naturalWidth, height: img.naturalHeight, zoom: 1, x: (VIEW - dimensions.width) / 2, y: (VIEW - dimensions.height) / 2 });
			setError(null);
		};
		img.onerror = () => { URL.revokeObjectURL(src); setError("图片无法读取。"); };
		img.src = src;
	};
	const save = async (next: string) => {
		setSaving(true); setError(null);
		try { await onChange(next); setCrop(null); }
		catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
		finally { setSaving(false); }
	};
	const saveCrop = () => {
		if (!crop || !image.current) return;
		const dimensions = placement(crop.width, crop.height, crop.zoom);
		const canvas = document.createElement("canvas"); canvas.width = 160; canvas.height = 160;
		const context = canvas.getContext("2d");
		if (!context) { setError("当前浏览器无法裁剪图片。"); return; }
		context.drawImage(image.current, crop.x * 160 / VIEW, crop.y * 160 / VIEW, dimensions.width * 160 / VIEW, dimensions.height * 160 / VIEW);
		void save(canvas.toDataURL("image/webp", .86));
	};
	const dimensions = crop ? placement(crop.width, crop.height, crop.zoom) : null;
	return <div className="avatar-editor">
		<div className="avatar-editor-head"><span className="msg-avatar user"><AvatarVisual value={value} size={30} /></span><div><strong>{label}</strong><small>选择图案，或上传并框选自己的图片</small></div></div>
		<div className="avatar-presets" role="group" aria-label={`${label}预设头像`}>{AVATAR_PRESETS.map((preset) => <button key={preset.id} type="button" title={preset.label} aria-label={preset.label} aria-pressed={value === preset.id} disabled={saving} onClick={() => void save(preset.id)}><AvatarVisual value={preset.id} size={28} /></button>)}<button type="button" title="上传图片" aria-label="上传图片" onClick={() => input.current?.click()}><Upload size={20} /></button></div>
		<input ref={input} className="visually-hidden" type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => { openFile(event.target.files?.[0]); event.target.value = ""; }} />
		{crop && dimensions && <div className="avatar-crop-panel" role="dialog" aria-label={`裁剪${label}`}>
			<div className="avatar-crop-title"><strong>选择头像范围</strong><button type="button" aria-label="取消裁剪" onClick={() => setCrop(null)}><X size={16} /></button></div>
			<div className="avatar-crop-viewport" onPointerDown={(event) => { drag.current = { x: event.clientX, y: event.clientY, fromX: crop.x, fromY: crop.y }; event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={(event) => { if (!drag.current) return; const x = Math.max(VIEW - dimensions.width, Math.min(0, drag.current.fromX + event.clientX - drag.current.x)); const y = Math.max(VIEW - dimensions.height, Math.min(0, drag.current.fromY + event.clientY - drag.current.y)); setCrop((previous) => previous && ({ ...previous, x, y })); }} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
				<img src={crop.src} alt="待裁剪图片" draggable={false} style={{ width: dimensions.width, height: dimensions.height, transform: `translate(${crop.x}px, ${crop.y}px)` }} /><span className="avatar-crop-frame" aria-hidden="true" />
			</div>
			<label>缩放 <input type="range" min="1" max="3" step="0.05" value={crop.zoom} onChange={(event) => { const zoom = Number(event.target.value); const old = placement(crop.width, crop.height, crop.zoom); const next = placement(crop.width, crop.height, zoom); setCrop({ ...crop, zoom, x: Math.max(VIEW - next.width, Math.min(0, crop.x - (next.width - old.width) / 2)), y: Math.max(VIEW - next.height, Math.min(0, crop.y - (next.height - old.height) / 2)) }); }} /></label>
			<button type="button" className="btn btn-primary" disabled={saving} onClick={saveCrop}><Check size={14} /> 使用此头像</button>
		</div>}
		{error && <small className="avatar-error" role="alert">{error}</small>}
	</div>;
}
