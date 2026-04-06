import Stripe from 'stripe';

async function test() {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_51P...', {
        apiVersion: '2025-02-24.acacia' as any,
    });

    try {
        const c = await stripe.customers.retrieve("cus_UGptI5wpIpZRzV");
        console.log("Returned:", c);
    } catch (err: any) {
        console.error("Caught error:", err.message);
    }
}
test();
