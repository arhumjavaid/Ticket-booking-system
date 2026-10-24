import { useEffect, useRef, useState } from 'react';
import { loadStripe, type Stripe, type StripeElements } from '@stripe/stripe-js';

const stripeByKey = new Map<string, Promise<Stripe | null>>();

interface StripeCheckoutProps {
  clientSecret: string;
  publishableKey: string;
  payLabel: string;
  disabled: boolean;
  onPaid: () => void;
}

/**
 * Stripe Payment Element for one PaymentIntent. Card data goes straight to
 * Stripe; success here only means "Stripe accepted it" - the booking is
 * confirmed server-side from Stripe's own record (webhook / sync).
 */
export function StripeCheckout({ clientSecret, publishableKey, payLabel, disabled, onPaid }: StripeCheckoutProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const stripeRef = useRef<{ stripe: Stripe; elements: StripeElements } | null>(null);
  const [ready, setReady] = useState(false);
  const [paying, setPaying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!publishableKey) {
      setError('Payments are not configured (missing Stripe publishable key).');
      return;
    }
    let cancelled = false;
    let element: { destroy(): void } | null = null;
    if (!stripeByKey.has(publishableKey)) stripeByKey.set(publishableKey, loadStripe(publishableKey));
    stripeByKey.get(publishableKey)!.then((stripe) => {
      if (cancelled || !stripe || !mountRef.current) return;
      const elements = stripe.elements({ clientSecret, appearance: { theme: 'stripe' } });
      const payment = elements.create('payment');
      payment.on('ready', () => setReady(true));
      payment.mount(mountRef.current);
      element = payment;
      stripeRef.current = { stripe, elements };
    });
    return () => {
      cancelled = true;
      element?.destroy();
      stripeRef.current = null;
    };
  }, [clientSecret, publishableKey]);

  async function pay() {
    if (!stripeRef.current) return;
    setPaying(true);
    setError(null);
    const { stripe, elements } = stripeRef.current;
    const { error: stripeError } = await stripe.confirmPayment({ elements, redirect: 'if_required' });
    if (stripeError) {
      // Declines are retryable on the same PaymentIntent while the hold lasts.
      setError(stripeError.message || 'Payment failed, please try another card.');
      setPaying(false);
      return;
    }
    onPaid();
  }

  return (
    <div className="stripe-checkout">
      <div ref={mountRef} />
      {error && (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      )}
      <button className="btn-block" onClick={pay} disabled={!ready || paying || disabled}>
        {paying ? 'Processing…' : payLabel}
      </button>
    </div>
  );
}
