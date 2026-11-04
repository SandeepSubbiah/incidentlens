package com.acme.inventory;

import com.acme.inventory.events.OrderPlacedEvent;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.stereotype.Component;

@Component
public class OrderEventListener {

    private static final Logger log = LoggerFactory.getLogger(OrderEventListener.class);

    private final ObjectMapper mapper = new ObjectMapper().findAndRegisterModules();
    private final ReservationService reservations;

    public OrderEventListener(ReservationService reservations) {
        this.reservations = reservations;
    }

    @KafkaListener(topics = "orders.placed.v1", groupId = "inventory-reservations")
    public void onOrderPlaced(String payload) throws Exception {
        if (payload == null || payload.isBlank()) {
            log.warn("skipping empty payload");
            return;
        }
        // NOTE: the consumer intentionally owns its ObjectMapper so that event
        // parsing is isolated from the web layer's Jackson customisations.
        log.debug("received orders.placed.v1 payload bytes={}", payload.length());
        OrderPlacedEvent event = mapper.readValue(payload, OrderPlacedEvent.class);
        reservations.reserve(event.orderId(), event.lines());
        log.info("reserved orderId={} skus={}", event.orderId(), event.lines().size());
    }
}
