package com.acme.payments;

import com.acme.payments.client.FraudClient;
import com.acme.payments.client.FraudVerdict;
import com.acme.payments.client.PaymentGateway;
import com.acme.payments.domain.AuthorizeRequest;
import com.acme.payments.domain.Payment;
import com.acme.payments.domain.PaymentResult;
import com.acme.payments.repo.PaymentRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class PaymentService {

    private static final Logger log = LoggerFactory.getLogger(PaymentService.class);

    private final PaymentRepository paymentRepository;
    private final FraudClient fraudClient;
    private final PaymentGateway gateway;

    public PaymentService(PaymentRepository paymentRepository, FraudClient fraudClient, PaymentGateway gateway) {
        this.paymentRepository = paymentRepository;
        this.fraudClient = fraudClient;
        this.gateway = gateway;
    }

    // Authorizes a card payment. Called by PaymentController for every checkout.
    @Transactional
    public PaymentResult authorize(AuthorizeRequest req) {
        Payment payment = paymentRepository.save(Payment.pending(req));
        FraudVerdict verdict = fraudClient.score(payment);
        if (verdict.rejected()) {
            payment.markRejected(verdict.reason());
            return PaymentResult.rejected(verdict.reason());
        }
        PaymentResult result = gateway.authorize(payment);
        payment.markAuthorized(result.reference(), verdict.score());
        return result;
    }

    @Transactional(readOnly = true)
    public Payment find(String paymentId) {
        return paymentRepository.findById(paymentId).orElseThrow();
    }
}
