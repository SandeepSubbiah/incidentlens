package com.acme.billing.gateway;

import io.github.resilience4j.circuitbreaker.annotation.CircuitBreaker;
import io.github.resilience4j.retry.annotation.Retry;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

@Component
public class GatewayClient {

    private final RestClient restClient;

    public GatewayClient(RestClient gatewayRestClient) {
        this.restClient = gatewayRestClient;
    }

    @Retry(name = "paymentGateway")
    @CircuitBreaker(name = "paymentGateway")
    public ChargeResponse createCharge(ChargeRequest request) {
        return restClient.post()
                .uri("/v1/charges")
                .contentType(MediaType.APPLICATION_JSON)
                .body(request)
                .retrieve()
                .body(ChargeResponse.class);
    }

    @Retry(name = "paymentGateway")
    public ChargeResponse getCharge(String chargeId) {
        return restClient.get()
                .uri("/v1/charges/{id}", chargeId)
                .retrieve()
                .body(ChargeResponse.class);
    }
}
