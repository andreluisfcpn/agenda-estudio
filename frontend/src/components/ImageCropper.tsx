import React, { useState, useRef, useEffect, useCallback } from 'react';

interface ImageCropperProps {
    imageSrc: string;
    onConfirm: (blob: Blob) => void;
    onCancel: () => void;
}

export default function ImageCropper({ imageSrc, onConfirm, onCancel }: ImageCropperProps) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [img, setImg] = useState<HTMLImageElement | null>(null);
    const [zoom, setZoom] = useState(1);
    const [offset, setOffset] = useState({ x: 0, y: 0 });
    const [dragging, setDragging] = useState(false);
    const dragStart = useRef({ x: 0, y: 0, ox: 0, oy: 0 });

    const SIZE = 256;

    useEffect(() => {
        const image = new Image();
        image.onload = () => {
            setImg(image);
            const scale = SIZE / Math.min(image.width, image.height);
            setZoom(scale);
            setOffset({ x: 0, y: 0 });
        };
        image.src = imageSrc;
    }, [imageSrc]);

    const draw = useCallback(() => {
        const canvas = canvasRef.current;
        if (!canvas || !img) return;
        const ctx = canvas.getContext('2d')!;
        ctx.clearRect(0, 0, SIZE, SIZE);

        const w = img.width * zoom;
        const h = img.height * zoom;
        const x = (SIZE - w) / 2 + offset.x;
        const y = (SIZE - h) / 2 + offset.y;

        ctx.save();
        ctx.beginPath();
        ctx.arc(SIZE / 2, SIZE / 2, SIZE / 2, 0, Math.PI * 2);
        ctx.clip();
        ctx.drawImage(img, x, y, w, h);
        ctx.restore();

        ctx.strokeStyle = 'rgba(255,255,255,0.3)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(SIZE / 2, SIZE / 2, SIZE / 2 - 1, 0, Math.PI * 2);
        ctx.stroke();
    }, [img, zoom, offset]);

    useEffect(() => { draw(); }, [draw]);

    const handleMouseDown = (e: React.MouseEvent) => {
        setDragging(true);
        dragStart.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
    };

    const handleMouseMove = (e: React.MouseEvent) => {
        if (!dragging) return;
        setOffset({
            x: dragStart.current.ox + (e.clientX - dragStart.current.x),
            y: dragStart.current.oy + (e.clientY - dragStart.current.y),
        });
    };

    const handleMouseUp = () => setDragging(false);

    const handleTouchStart = (e: React.TouchEvent) => {
        const t = e.touches[0];
        setDragging(true);
        dragStart.current = { x: t.clientX, y: t.clientY, ox: offset.x, oy: offset.y };
    };

    const handleTouchMove = (e: React.TouchEvent) => {
        if (!dragging) return;
        const t = e.touches[0];
        setOffset({
            x: dragStart.current.ox + (t.clientX - dragStart.current.x),
            y: dragStart.current.oy + (t.clientY - dragStart.current.y),
        });
    };

    const handleConfirm = () => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        if (img) {
            const ctx = canvas.getContext('2d')!;
            ctx.clearRect(0, 0, SIZE, SIZE);
            const w = img.width * zoom;
            const h = img.height * zoom;
            const x = (SIZE - w) / 2 + offset.x;
            const y = (SIZE - h) / 2 + offset.y;
            ctx.drawImage(img, x, y, w, h);
        }
        canvas.toBlob((blob) => {
            if (blob) onConfirm(blob);
        }, 'image/jpeg', 0.9);
    };

    const minZoom = img ? SIZE / Math.max(img.width, img.height) * 0.5 : 0.1;
    const maxZoom = img ? SIZE / Math.min(img.width, img.height) * 3 : 5;

    return (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px' }}>
            <div style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', textAlign: 'center' }}>
                Arraste para posicionar · Use o slider para zoom
            </div>

            <div style={{
                position: 'relative', width: SIZE, height: SIZE,
                borderRadius: '50%', overflow: 'hidden',
                cursor: dragging ? 'grabbing' : 'grab',
                border: '3px solid var(--accent-primary)',
                boxShadow: '0 0 30px rgba(var(--accent-primary-rgb, 99,102,241), 0.3)',
            }}>
                <canvas
                    ref={canvasRef}
                    width={SIZE}
                    height={SIZE}
                    style={{ display: 'block' }}
                    onMouseDown={handleMouseDown}
                    onMouseMove={handleMouseMove}
                    onMouseUp={handleMouseUp}
                    onMouseLeave={handleMouseUp}
                    onTouchStart={handleTouchStart}
                    onTouchMove={handleTouchMove}
                    onTouchEnd={handleMouseUp}
                />
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', width: '100%', maxWidth: 280 }}>
                <span style={{ fontSize: '0.75rem' }}>🔍−</span>
                <input
                    type="range"
                    min={minZoom}
                    max={maxZoom}
                    step={0.01}
                    value={zoom}
                    onChange={e => setZoom(parseFloat(e.target.value))}
                    style={{ flex: 1, accentColor: 'var(--accent-primary)' }}
                />
                <span style={{ fontSize: '0.75rem' }}>🔍+</span>
            </div>

            <div style={{ display: 'flex', gap: '10px' }}>
                <button className="btn btn-secondary btn-sm" onClick={onCancel}>Cancelar</button>
                <button className="btn btn-primary btn-sm" onClick={handleConfirm}>✅ Usar esta foto</button>
            </div>
        </div>
    );
}
