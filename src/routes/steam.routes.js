import express from 'express';
import { steamController } from '../controllers/SteamController';

const router = express.Router();

router.get('/', steamController.getToken);
router.get('/:id', steamController.getDetail);

module.exports = router;