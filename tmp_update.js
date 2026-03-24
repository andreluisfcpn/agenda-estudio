const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, 'frontend/src/pages/LandingPage.tsx');
let content = fs.readFileSync(file, 'utf8');

// 1. We want to extract the Agenda section
const agendaStart = content.indexOf('                {/* Dynamic Agenda Demo Section */}');
const servicesCarouselStart = content.indexOf('                {/* Services Carousel */}');
const servicesCarouselEnd = content.indexOf('                {/* Refined Commercial Section - Glassmorphism & Depth */}');

// The Agenda section ends exactly where the Services Carousel begins.
const agendaSection = content.substring(agendaStart, servicesCarouselStart);

// 2. We want to extract the ServicesCarousel section (which is just a comment and `<ServicesCarousel />`)
const servicesSection = content.substring(servicesCarouselStart, servicesCarouselEnd);

// 3. We want to remove the Refined Commercial Section entirely. It ends exactly where `</main>` begins.
const mainEnd = content.indexOf('            </main>');
const commercialSection = content.substring(servicesCarouselEnd, mainEnd);

// Restructure:
// First, add the servicesSection
// Then, add the agendaSection, modified to include the RS 108 highlight.
let newAgendaSection = agendaSection.replace(
    `                            <p style={{ color: 'rgba(255,255,255,0.5)', lineHeight: 1.8, marginBottom: '40px' }}>
                                Nosso sistema exclusivo permite que você reserve seu horário em segundos. Sem burocracia, sem espera. A agilidade que seu projeto exige.
                            </p>`,
    `                            <p style={{ color: 'rgba(255,255,255,0.5)', lineHeight: 1.8, marginBottom: '24px' }}>
                                Nosso sistema exclusivo permite que você reserve seu horário em segundos. Sem burocracia, sem espera. A agilidade que seu projeto exige.
                            </p>
                            
                            <div style={{ 
                                display: 'inline-flex', alignItems: 'center', gap: '12px', 
                                background: 'rgba(0, 108, 137, 0.15)', border: '1px solid rgba(0, 108, 137, 0.3)', 
                                padding: '16px 24px', borderRadius: '16px', marginBottom: '40px'
                            }}>
                                <Zap size={24} color={COLORS.accent} />
                                <div>
                                    <div style={{ fontSize: '0.875rem', color: 'rgba(255,255,255,0.6)', textTransform: 'uppercase', letterSpacing: '1px', fontWeight: 700, marginBottom: '4px' }}>
                                        Valor Acessível
                                    </div>
                                    <div style={{ fontSize: '1.5rem', fontWeight: 800, color: COLORS.white }}>
                                        A partir de <span style={{ color: COLORS.accent }}>R$ 108</span> <span style={{ fontSize: '1rem', fontWeight: 500, color: 'rgba(255,255,255,0.5)' }}>/hora</span>
                                    </div>
                                </div>
                            </div>`
);

// We reconstruct the content between agendaStart and mainEnd
const newContent = content.substring(0, agendaStart) + servicesSection + '\n' + newAgendaSection + content.substring(mainEnd);

fs.writeFileSync(file, newContent);
console.log("File successfully updated");
