import React from 'react';
import { motion } from 'framer-motion';

// Using the Búzios Digital 'accent' light-cyan for floating particles
const COLORS = {
    accent: '#F4F9FA'
};

export default function AmbientBackground() {
    // Generate static particles array safely
    const [particles] = React.useState(() => 
        Array.from({ length: 40 }).map((_, i) => ({
            id: i,
            size: Math.random() * 3 + 1,
            initialX: Math.random() * 100,
            initialY: Math.random() * 100,
            duration: Math.random() * 30 + 15,
            delay: Math.random() * 10,
            peakOpacity: Math.random() * 0.4 + 0.1
        }))
    );

    return (
        <React.Fragment>
            {/* SEO Metadata & Grain Texture Container */}
            <svg style={{ position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 9999, opacity: 0.04 }}>
                <filter id="grain">
                    <feTurbulence type="fractalNoise" baseFrequency="0.7" numOctaves="3" stitchTiles="stitch" />
                    <feColorMatrix type="saturate" values="0" />
                </filter>
                <rect width="100%" height="100%" filter="url(#grain)" />
            </svg>
            
            {/* Pure CSS animated grid */}
            <div className="grid-overlay" />
            
            {/* Framer Motion Floating Particles */}
            <div style={{ position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 0, overflow: 'hidden' }}>
                {particles.map((p) => (
                    <motion.div
                        key={p.id}
                        initial={{
                            x: `${p.initialX}vw`,
                            y: `${p.initialY}vh`,
                            opacity: 0,
                        }}
                        animate={{
                            y: [`${p.initialY}vh`, `-10vh`],
                            opacity: [0, p.peakOpacity, 0],
                            scale: [1, 1.5, 1]
                        }}
                        transition={{
                            duration: p.duration,
                            repeat: Infinity,
                            delay: p.delay,
                            ease: "linear",
                        }}
                        style={{
                            position: 'absolute',
                            width: p.size,
                            height: p.size,
                            backgroundColor: COLORS.accent,
                            borderRadius: '50%',
                            boxShadow: `0 0 ${p.size * 3}px ${COLORS.accent}`,
                        }}
                    />
                ))}
            </div>
        </React.Fragment>
    );
}
