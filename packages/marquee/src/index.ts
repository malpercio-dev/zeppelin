import { Hono } from 'hono';

export class LeafletServer {
    /** The Hono app for mounting the Leaflet Server */
    private app: Hono;

    constructor() {
        this.app = new Hono();
    }
}
