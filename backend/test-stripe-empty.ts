import Stripe from 'stripe';

try {
    const s = new Stripe('', { apiVersion: '2026-03-25.dahlia' as any });
    s.balance.retrieve().catch(e => console.log("Retrieve threw:", e.message));
} catch (e: any) {
    console.log("Constructor threw:", e.message);
}
