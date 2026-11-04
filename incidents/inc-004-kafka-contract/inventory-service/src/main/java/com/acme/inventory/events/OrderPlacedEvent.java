package com.acme.inventory.events;

import java.time.Instant;
import java.util.List;

public record OrderPlacedEvent(
        String orderId,
        String customerId,
        List<OrderLine> lines,
        Instant placedAt,
        String channel) {

    public record OrderLine(String sku, int quantity) {}
}
